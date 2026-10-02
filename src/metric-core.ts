/**
 * 纯计算核心:确定性整数运算,无任何 I/O 与副作用。
 * 主线程(分片降级路径)与 worker_threads 线程池共用同一份实现,
 * 保证两条路径的输出逐字节一致。
 */

/**
 * 32 位整数 xorshift-multiply 混合(确定性、无随机源、无浮点误差),
 * 是真实的逐轮 CPU 运算,不是空转也不是常量返回。
 */
export function mixHash32(state: number, round: number): number {
  let h = (state ^ round) | 0;
  h ^= h << 13;
  h = (h | 0) >>> 0;
  h ^= h >>> 17;
  h = (h | 0) >>> 0;
  h ^= h << 5;
  h = Math.imul(h, 0x9e3779b9) >>> 0;
  return h;
}

export function isPrime(candidate: number): boolean {
  if (candidate < 2) {
    return false;
  }
  if (candidate % 2 === 0) {
    return candidate === 2;
  }
  const limit = Math.floor(Math.sqrt(candidate));
  for (let divisor = 3; divisor <= limit; divisor += 2) {
    if (candidate % divisor === 0) {
      return false;
    }
  }
  return true;
}

/**
 * 每个单元格一次的真实 CPU 计算(纯函数版本)。
 * 输出只由 (i, rounds) 决定,与执行线程、分片方式、调度顺序无关。
 */
export function computeMetric(i: number, rounds: number): string {
  let h = (0x811c9dc5 ^ (i + 1)) >>> 0;

  for (let round = 0; round < rounds; round += 1) {
    h = mixHash32(h, round);
  }

  // 在哈希结果附近试除寻找一个质数,进一步增加真实的整数运算量。
  const primeCandidateBase = (h % 4096) * 2 + 1001;
  let candidate = primeCandidateBase;
  while (!isPrime(candidate)) {
    candidate += 2;
  }

  const metric = (h % 100000) / 100 + (candidate % 97) / 100;
  return metric.toFixed(2);
}
