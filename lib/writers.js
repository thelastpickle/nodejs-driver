'use strict';
const events = require('events');

const types = require('./types');
const utils = require('./utils.js');
const FrameHeader = types.FrameHeader;

/**
 * Contains the logic to write all the different types to the frame.
 */
class FrameWriter {
  /**
   * Creates a new instance of FrameWriter.
   * @param {Number} opcode
   */
  constructor(opcode) {
    if (!opcode) {
      throw new Error('Opcode not provided');
    }
    this.buffers = [];
    this.opcode = opcode;
    this.bodyLength = 0;
  }

  add(buf) {
    this.buffers.push(buf);
    this.bodyLength += buf.length;
  }

  writeShort(num) {
    const buf = utils.allocBufferUnsafe(2);
    buf.writeUInt16BE(num, 0);
    this.add(buf);
  }

  writeInt(num) {
    const buf = utils.allocBufferUnsafe(4);
    buf.writeInt32BE(num, 0);
    this.add(buf);
  }

  /** @param {Long} num */
  writeLong(num) {
    this.add(types.Long.toBuffer(num));
  }

  /**
   * Writes bytes according to Cassandra <int byteLength><bytes>
   * @param {Buffer|null|types.unset} bytes
   */
  writeBytes(bytes) {
    if (bytes === null) {
      //Only the length buffer containing -1
      this.writeInt(-1);
      return;
    }
    if (bytes === types.unset) {
      this.writeInt(-2);
      return;
    }
    //Add the length buffer
    this.writeInt(bytes.length);
    //Add the actual buffer
    this.add(bytes);
  }

  /**
   * Writes a buffer according to Cassandra protocol: bytes.length (2) + bytes
   * @param {Buffer} bytes
   */
  writeShortBytes(bytes) {
    if(bytes === null) {
      //Only the length buffer containing -1
      this.writeShort(-1);
      return;
    }
    //Add the length buffer
    this.writeShort(bytes.length);
    //Add the actual buffer
    this.add(bytes);
  }

  /**
   * Writes a single byte
   * @param {Number} num Value of the byte, a number between 0 and 255.
   */
  writeByte(num) {
    this.add(utils.allocBufferFromArray([num]));
  }

  writeString(str) {
    if (typeof str === "undefined") {
      throw new Error("can not write undefined");
    }
    const len = Buffer.byteLength(str, 'utf8');
    const buf = utils.allocBufferUnsafe(2 + len);
    buf.writeUInt16BE(len, 0);
    buf.write(str, 2, buf.length-2, 'utf8');
    this.add(buf);
  }

  writeLString(str) {
    const len = Buffer.byteLength(str, 'utf8');
    const buf = utils.allocBufferUnsafe(4 + len);
    buf.writeInt32BE(len, 0);
    buf.write(str, 4, buf.length-4, 'utf8');
    this.add(buf);
  }

  writeStringList(values) {
    this.writeShort(values.length);
    values.forEach(this.writeString, this);
  }

  writeCustomPayload(payload) {
    const keys = Object.keys(payload);
    this.writeShort(keys.length);
    keys.forEach(function (k) {
      this.writeString(k);
      this.writeBytes(payload[k]);
    }, this);
  }

  writeStringMap(map) {
    const keys = [];
    for (const k in map) {
      if (map.hasOwnProperty(k)) {
        keys.push(k);
      }
    }

    this.writeShort(keys.length);

    for(let i = 0; i < keys.length; i++) {
      const key = keys[i];
      this.writeString(key);
      this.writeString(map[key]);
    }
  }

  /**
   * @param {Number} version
   * @param {Number} streamId
   * @param {Number} [flags] Header flags
   * @returns {Buffer}
   * @throws {TypeError}
   */
  write(version, streamId, flags) {
    const header = new FrameHeader(version, flags || 0, streamId, this.opcode, this.bodyLength);
    const headerBuffer = header.toBuffer();
    this.buffers.unshift(headerBuffer);
    return Buffer.concat(this.buffers, headerBuffer.length + this.bodyLength);
  }
}

/**
 * Represents a queue that process one write at a time (FIFO).
 * @extends {EventEmitter}
 */
class WriteQueue extends events.EventEmitter {
  /**
   * Creates a new WriteQueue instance.
   * @param {Socket} netClient
   * @param {Encoder} encoder
   * @param {ClientOptions} options
   */
  constructor(netClient, encoder, options) {
    super();
    this.netClient = netClient;
    this.encoder = encoder;
    this.isRunning = false;
    /** @type {Array<{operation: OperationState, callback: Function}>} */
    this.queue = [];
    this.coalescingThreshold = options.socketOptions.coalescingThreshold;
    this.error = null;
  }

  /**
   * Enqueues a new request
   * @param {OperationState} operation
   * @param {Function} callback The write callback.
   */
  push(operation, callback) {
    const self = this;
    if (this.error) {
      // There was a write error, there is no point in further trying to write to the socket.
      return process.nextTick(function writePushError() {
        callback(self.error);
      });
    }
    this.queue.push({ operation: operation, callback: callback});
    this.run();
  }

  run() {
    if (!this.isRunning) {
      this.process();
    }
  }

  process() {
    const self = this;
    utils.whilst(
      function condition() {
        return self.queue.length > 0;
      },
      function whileProcess(next) {
        self.isRunning = true;
        const buffers = [];
        const callbacks = [];
        let totalLength = 0;
        while (totalLength < self.coalescingThreshold && self.queue.length > 0) {
          const writeItem = self.queue.shift();
          try {
            const data = writeItem.operation.request.write(self.encoder, writeItem.operation.streamId);
            totalLength += data.length;
            buffers.push(data);
            callbacks.push(writeItem.callback);
          }
          catch (err) {
            writeItem.callback(err);
            // Break and flush what we have
            break;
          }
        }
        if (buffers.length === 0) {
          // No need to invoke socket.write()
          return next();
        }
        // Before invoking socket.write(), mark that the request has been written to avoid race conditions.
        for (let i = 0; i < callbacks.length; i++) {
          callbacks[i]();
        }
        self.netClient.write(Buffer.concat(buffers, totalLength), function socketWriteCallback(err) {
          if (err) {
            self.setWriteError(err);
          }
          // Allow IO between writes
          setImmediate(next);
        });
      },
      function loopFinished() {
        // The queue is now empty
        self.isRunning = false;
      }
    );
  }

  /**
   * Emits the 'error' event and callbacks items that haven't been written and clears them from the queue.
   * @param err
   */
  setWriteError(err) {
    err.isSocketError = true;
    this.error = new types.DriverError('Socket was closed');
    this.error.isSocketError = true;
    // Use an special flag for items that haven't been written
    this.error.requestNotWritten = true;
    this.error.innerError = err;
    const q = this.queue;
    // Not more items can be added to the queue.
    this.queue = utils.emptyArray;
    for (let i = 0; i < q.length; i++) {
      const item = q[i];
      // Use the error marking that it was not written
      item.callback(this.error);
    }
  }
}

exports.WriteQueue = WriteQueue;
exports.FrameWriter = FrameWriter;
