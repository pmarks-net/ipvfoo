// This dead-simple LRU cache relies on the fact that Chrome maintains the
// order of properties attached to an object.  This doesn't always work for
// numeric-looking keys, so I append a '~' to keep them everything stringy.

function LRU(size) {
  this.room = size;
  this.items = {};
}

LRU.prototype.setItem = function(key, value) {
  key += '~';
  this._forget(key);
  if (this.room == 0) {
    // If we're out of room, forget the oldest key.
    for (k in this.items) {
      if (this._forget(k)) break;
    }
  }
  this.items[key] = value;
  this.room--;
}

LRU.prototype.getItem = function(key) {
  key += '~';
  return this.items[key];
}

LRU.prototype.forgetItem = function(key) {
  key += '~';
  this._forget(key);
}

LRU.prototype._forget = function(key) {
  if (this.items.hasOwnProperty(key)) {
    delete this.items[key];
    this.room++;
    return true;
  }
  return false;
}
