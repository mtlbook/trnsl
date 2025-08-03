// ----------  concurrency.js  ----------
export class Semaphore {
  constructor(max) {
    this.max = max;
    this.running = 0;
    this.queue = [];
  }

  async acquire() {
    return new Promise(res => {
      const tryRun = () => {
        if (this.running < this.max) {
          this.running++;
          res();
        } else {
          this.queue.push(tryRun);
        }
      };
      tryRun();
    });
  }

  release() {
    this.running--;
    if (this.queue.length) this.queue.shift()();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
