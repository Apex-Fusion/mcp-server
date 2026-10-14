// Preloaded into the keygen process of keygen-cli.test.ts (node --require): stdout takes a write only after 300 ms, and only then calls
// the callback of that write, as a pipe that is slow to drain does. A process that exits straight after write() loses the text; one that
// exits from the callback does not.
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
  const done = typeof encoding === 'function' ? encoding : callback;
  setTimeout(() => realWrite(chunk, () => { if (done) done(); }), 300);
  return true;
};
