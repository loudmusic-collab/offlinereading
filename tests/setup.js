// Run the browser modules under Node: linkedom supplies DOMParser (the same
// pairing a server-side Readability pipeline would use) and fake-indexeddb
// supplies IndexedDB.
import 'fake-indexeddb/auto';
import { DOMParser } from 'linkedom';

globalThis.DOMParser = DOMParser;
