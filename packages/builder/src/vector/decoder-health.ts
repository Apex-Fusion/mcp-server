// packages/builder/src/vector/decoder-health.ts
// The process stops when its decoder library cannot decode a known value, so that its supervisor starts it again.
//
// `withDecoderCheck` wraps the tool registration of a server: after each tool call, whether the call gave an answer or failed, the
// decoder decodes a known value (a few microseconds). When it cannot, the process stops, after the answer of that call is written.
//
// The check does not look at the error of the call. Lucid and this package catch the errors of the decoder and give others (an address
// that does not parse, a datum that is not read), so the error that reaches the end of a call does not say that the decoder is the cause.
//
// The stop is a function that the entry point sets (index.ts). Without one nothing ends and the check does not run, so a program that
// imports this package as a library never loses its process.
//
// Three limits. The restore of the stack pointer (restoreStackPointer) puts the pointer back; it does not give back other memory that a
// failed call of the library took, so the self-check with the stop stays the last line. The self-check covers the decoder library only,
// not the script evaluator of Lucid, which is a separate WebAssembly instance. When the process stops, a call of another client that needs
// longer than the grace time (stop-server.ts) gets no answer.
import { CML } from '@lucid-evolution/lucid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** A value that every working decoder decodes: Plutus data, constructor 0 with no fields. */
const KNOWN_VALUE = 'd87980';
const STOP_LINE = 'The decoder library cannot decode a known value. The process stops so that its supervisor starts it again.';

let stop: (() => void) | undefined;
let stopping = false;

/** Sets the function that ends the process (the entry point does), or takes it away (undefined). */
export function setDecoderStop(fn: (() => void) | undefined): void {
  stop = fn;
  stopping = false;
}

/** The self-check: does the decoder library decode a known value? */
export function decoderWorks(): boolean {
  try {
    CML.PlutusData.from_cbor_hex(KNOWN_VALUE).free();
    return true;
  } catch {
    return false;
  }
}

/** The function of the decoder library that moves its stack pointer by a number of bytes and returns the new value. */
type MoveStackPointer = (delta: number) => number;
let moveStackPointer: MoveStackPointer | undefined;
let stackStart: number | undefined;

/**
 * Starts to watch the stack pointer of the decoder library: reads it two times, and keeps the value as the start value when the two reads
 * agree. The entry point calls it once, after the library is loaded and while no call into the library is in progress. Returns false, and
 * watches nothing, when `library` (CML by default) has no such export, as another build of the library may have none, or the reads differ.
 */
export function watchStackPointer(library: object = CML): boolean {
  moveStackPointer = undefined;
  stackStart = undefined;
  const instance: unknown = Reflect.get(library, '__wasm');
  if (typeof instance !== 'object' || instance === null) return false;
  const move: unknown = Reflect.get(instance, '__wbindgen_add_to_stack_pointer');
  if (typeof move !== 'function') return false;
  const read = (delta: number): number => {
    const value: unknown = Reflect.apply(move, instance, [delta]);
    return typeof value === 'number' ? value : NaN;
  };
  const first = read(0);
  if (!Number.isInteger(first) || first !== read(0)) return false;
  moveStackPointer = read;
  stackStart = first;
  return true;
}

/** Stops the watch of the stack pointer. */
export function unwatchStackPointer(): void {
  moveStackPointer = undefined;
  stackStart = undefined;
}

/**
 * When a stack pointer is watched and a tool call has left it below its start value, puts it back to the start value, reads it again, and
 * writes one line to stderr with the difference. A pointer at the start value is not touched, and one above it is not touched either: the
 * self-check decides. This is safe because calls into the library are synchronous: when a tool call has ended, no call into the library is
 * in progress, so the pointer must be at its start value. The restore runs before the self-check (withDecoderCheck), so a call that left
 * the pointer low does not stop a process whose library works again. It does not give back other memory that a failed call took.
 */
export function restoreStackPointer(): void {
  if (moveStackPointer === undefined || stackStart === undefined) return;
  try {
    const now = moveStackPointer(0);
    if (!(now < stackStart)) return;
    moveStackPointer(stackStart - now);
    const confirmed = moveStackPointer(0) === stackStart;
    console.error(`The stack pointer of the decoder library was ${stackStart - now} bytes below its start value after a tool call. ${confirmed ? 'The server put it back.' : 'The server could not put it back.'}`);
  } catch {
    // The self-check decides.
  }
}

/**
 * `server`, with each tool that is registered through it checked after each call: first the stack pointer of the library is put back when
 * the call left it changed, and then, when a stop is set and the decoder cannot decode a known value, one line goes to stderr and the stop
 * is called once, after the call has returned its answer. The answer, the arguments and the errors of a tool do not change.
 */
export function withDecoderCheck(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (property !== 'tool' || typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const handler = args[args.length - 1];
        if (typeof handler === 'function') {
          args[args.length - 1] = async (...callArgs: unknown[]) => {
            try {
              return await handler(...callArgs);
            } finally {
              restoreStackPointer();
              if (stop !== undefined && !stopping && !decoderWorks()) {
                stopping = true;
                console.error(STOP_LINE);
                setImmediate(stop);
              }
            }
          };
        }
        return member.apply(target, args);
      };
    },
  });
}
