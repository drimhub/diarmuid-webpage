// Node-only: a record/replay store (see src/providers/http.js) backed by one JSON file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryStore } from '../src/providers/http.js';

export class FileStore extends MemoryStore {
  constructor(path) {
    super(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).entries : {});
    this.path = path;
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ entries: this.entries }, null, 1));
  }
}
