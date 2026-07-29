// Local, per-user audit log. Records intent at signing time, not confirmed
// submission — the signer has no network, so it cannot know whether a submit
// later succeeded. That over-counts on a failed submit, which is conservative.
//
// The log file is untrusted input every time it is read: it can be hand-edited,
// truncated by a process that died mid-write, or produced by a future version
// of this module with a different entry shape. Every method below treats it
// accordingly. Two different failure shapes get two different responses, on
// purpose:
//   - The whole file is unreadable or not a JSON array: nothing in it can be
//     trusted, so start clean. Loud on stderr, never silent (see load()).
//   - The file is a JSON array but one element in it is garbage (not an
//     object — most dangerously `null`, see below): drop only that element
//     and keep the rest. A single bad entry must not erase an otherwise-good
//     day's history, since committedTodayLovelace() is exactly what the
//     daily spend limit depends on.
// Nothing here ever throws out of committedTodayLovelace() or recent(): a
// thrown exception from a "how much have I already spent" query is the kind
// of bug most likely to be handled upstream by assuming zero — which would
// silently defeat the daily limit. append() is the one exception: see its
// own comment for why a write failure there throws instead of swallowing.
//
// CONTRACT for callers of append(): it can throw. If you wrap it in
// try/catch — a reasonable instinct, since an uncaught throw from an audit
// module makes for an ugly tool-call failure — catching that throw must NOT
// be followed by still returning a signature you already produced. append()
// is normally called immediately after a transaction is signed; catching its
// throw and returning the signature anyway reproduces exactly the failure
// this module exists to prevent, just one call site later: a real signature
// reaches the caller while no durable record of it exists on disk, so the
// next process's committedTodayLovelace() will never count it.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

export interface AuditEntry {
  timestamp: string;
  txHash: string;
  decision: 'signed' | 'refused';
  netOutflowLovelace: string;
  reason?: string;
  assetMovements: number;
}

export class AuditLog {
  private entries: AuditEntry[] = [];

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(parsed)) {
        throw new Error('log file did not contain a JSON array');
      }

      // JSON.parse can hand back array elements of any shape. Most of those
      // are harmless here even though they are not real AuditEntry objects:
      // a stray string, number, or boolean silently returns `undefined` for
      // `.decision`, which just fails the `!== 'signed'` check like any other
      // unrecognised value. `null` is the one exception — property access on
      // null throws — so committedTodayLovelace() would crash on the entry
      // AFTER it, and every entry after that, not just skip the bad one.
      // Filtering to object-shaped, non-array elements up front means every
      // other method can assume its entries are at least objects, even if
      // individual fields on them still turn out to be garbage (handled
      // separately, per field, in committedTodayLovelace()).
      const usable = parsed.filter(
        (e): e is AuditEntry => e !== null && typeof e === 'object' && !Array.isArray(e)
      );
      if (usable.length !== parsed.length) {
        console.error(
          `[audit] ${this.filePath}: dropped ${parsed.length - usable.length} of ${parsed.length} log entries that were not objects (e.g. null); keeping the rest`
        );
      }
      this.entries = usable;
    } catch (err) {
      // A corrupt log must not stop the signer from working, and must not be
      // silently trusted either. Start clean; the file is overwritten on the
      // next append. This branch also catches a valid-JSON-but-wrong-shape
      // file (an object, `null`, a string, ...) via the throw above — that is
      // just as untrustworthy as a syntax error and gets the same fresh-start
      // treatment and the same stderr line.
      console.error(
        `[audit] ${this.filePath} was unreadable (${err instanceof Error ? err.message : String(err)}); starting a fresh log`
      );
      this.entries = [];
    }
  }

  /**
   * Persists `entry`. Can throw if the log cannot be durably written — see
   * the CONTRACT note at the top of this file before wrapping this in
   * try/catch.
   */
  append(entry: AuditEntry): void {
    // Pushed before the write is attempted: if the write below fails, this
    // process's own in-memory state (committedTodayLovelace(), recent())
    // must still reflect the decision that was actually made. Losing it here
    // would under-count even within this same process, which would be worse
    // than the cross-restart gap discussed below.
    this.entries.push(entry);

    // Written to a temp file and renamed into place, rather than written
    // directly to this.filePath, to survive a process kill mid-write (power
    // loss, OOM kill — not a normal error path, but a real one for a
    // long-running signer). Writing this.filePath directly has two problems
    // a temp file avoids: writeFileSync truncates its target the moment it
    // opens it, before a single byte is written, so a kill right after that
    // truncation would destroy the entire existing log, not just fail to add
    // the new entry; and even a completed write can leave the file
    // half-written if the kill lands mid-syscall. Neither can happen to
    // this.filePath here, because this.filePath is never opened for writing
    // at all — only tmpPath is. The rename that publishes tmpPath over
    // this.filePath is a single directory-entry update on the same
    // filesystem, which POSIX and Windows both perform atomically: a kill
    // during the rename itself cannot leave this.filePath half-written
    // either, it is simply still the old complete file or already the new
    // complete one. The only entry a kill can cost is the one in flight —
    // shrinking the worst case from "lose the whole day's history" to "lose
    // at most this one entry", which is the same entry append() already
    // cannot guarantee past a hard kill regardless of persistence strategy.
    const tmpPath = `${this.filePath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(this.entries, null, 2) + '\n');
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[audit] could not write ${this.filePath}: ${message}`);
      // Deliberately rethrown rather than swallowed — see the CONTRACT note
      // at the top of this file for what a catching caller must not do.
      // Swallowing would make append() return normally — a plausible-
      // looking success — while the entry silently exists only in this
      // process's memory. That is fine until the next restart: a fresh
      // AuditLog reloads from disk, does not find this entry, and
      // committedTodayLovelace() under-reports by exactly its amount. For a
      // 'signed' entry that is precisely the failure this module exists to
      // prevent — it raises the effective daily cap with no visible symptom
      // until someone goes looking. Making the write failure loud and
      // synchronous, at the moment it happens, is the fail-closed choice.
      throw new Error(`Audit log write failed (entry kept in memory only, not persisted): ${message}`);
    }
  }

  /** Lovelace committed today (UTC) by signed transactions. Refusals do not count. */
  committedTodayLovelace(): bigint {
    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);
    const cutoff = startOfDayUtc.getTime();

    let total = 0n;
    for (const e of this.entries) {
      if (e.decision !== 'signed') continue;
      const t = new Date(e.timestamp).getTime();
      if (Number.isNaN(t) || t < cutoff) continue;

      let amount: bigint;
      try {
        amount = BigInt(e.netOutflowLovelace);
      } catch {
        // Not parseable at all (non-numeric text, a decimal, ...). Ignore
        // rather than crash the signer's accounting.
        continue;
      }
      // BigInt string parsing accepts more than plain positive integers.
      // BigInt('') is 0n — a harmless no-op, not a crash and not skipped,
      // just zero. BigInt('-5000000') is a valid negative bigint, and that
      // one is NOT harmless: adding a negative amount can only ever reduce
      // the running total, i.e. under-report — the one direction this
      // function must never move in. Nothing in the real pipeline can
      // produce a negative netOutflowLovelace (policy.ts sums non-negative
      // output lovelace plus a non-negative fee), so a negative value here
      // can only come from a corrupted or hand-edited log entry. Treated the
      // same as any other unparseable amount: skipped, not subtracted.
      if (amount < 0n) continue;
      total += amount;
    }
    return total;
  }

  recent(limit: number): AuditEntry[] {
    // Array.prototype.slice(-0) behaves as slice(0): -0 is not < 0, so the
    // "count back from the end" branch never triggers, and the call returns
    // the ENTIRE array instead of none. limit <= 0 is handled explicitly so
    // recent(0) means "no entries" rather than "all of them" — and the same
    // guard makes a negative limit equally harmless instead of doing
    // whatever slice() would otherwise do with it (drop entries off the
    // front, which is not a sensible reading of "give me N recent entries").
    if (limit <= 0) return [];
    return this.entries.slice(-limit).reverse();
  }
}
