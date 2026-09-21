// llama-bench 흉내. --mmap을 받으면 인자 오류로 죽고, 없으면 결과 한 줄을 낸다.
const args = process.argv.slice(2);
if (args.includes('--mmap')) {
  process.stderr.write('error: invalid parameter for argument: --mmap\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ n_prompt: 0, n_gen: 128, avg_ts: 12.34, stddev_ts: 0.1 }) + '\n');
process.exit(0);
