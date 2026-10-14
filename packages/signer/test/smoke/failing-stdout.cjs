// Preloaded into the keygen process of keygen-cli.test.ts (node --require): stdout refuses the write and says so to its callback, as a
// closed pipe does. Nothing is written.
process.stdout.write = (chunk, encoding, callback) => {
  const done = typeof encoding === 'function' ? encoding : callback;
  if (done) done(new Error('EPIPE'));
  return false;
};
