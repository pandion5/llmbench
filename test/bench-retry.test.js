// 적재 옵션을 빌드가 받지 않을 때 그 인자를 빼고 다시 도는지 본다.
const assert = require('assert');
const path = require('path');
const bench = require('../src/bench.js');

const fake = path.join(__dirname, 'fake-bench.js');

(async () => {
  // 1) --mmap을 쓰는 빌드로 가정. 첫 시도는 죽고 두 번째는 살아야 한다.
  bench.loadModeState.flag = 'mmap';
  const buildArgs = () => [fake, ...bench.loadModeArgs(process.execPath, 'none')];
  assert.deepStrictEqual(buildArgs().slice(1), ['--mmap', '0'], '첫 인자 구성');

  const logs = [];
  const r = await bench.runBenchExe(process.execPath, buildArgs, (o, l) => logs.push(l));
  assert.ok(r.out.includes('"n_gen":128'), '결과를 받지 못했다');
  assert.strictEqual(bench.loadModeState.flag, 'none', '재시도 뒤 상태');
  assert.ok(logs.some((l) => l.includes('빼고 다시 돌린다')), '재시도 안내가 없다');

  // 2) 이미 none이면 인자를 안 붙이고 한 번에 끝난다.
  const r2 = await bench.runBenchExe(process.execPath, () => [fake], () => {});
  assert.ok(r2.out.includes('"n_gen":128'), '두 번째 실행 결과');

  // 3) 적재 옵션과 무관한 실패는 그대로 오류로 올라온다.
  bench.loadModeState.flag = 'none';
  await bench
    .runBenchExe(process.execPath, () => ['-e', 'process.stderr.write("boom");process.exit(3)'], () => {})
    .then(
      () => assert.fail('실패가 그대로 올라와야 한다'),
      (e) => assert.ok(/종료코드 3/.test(e.message), e.message)
    );

  // 4) 3.6을 끈 상태의 크기면 RAM 용량이 아니라 대역폭이 병목이어야 한다.
  const hw = { ramGB: 95.8, ram: { bandwidthGBps: 115.2 } };
  const v = bench.computeVerdict({ genTokPerSec: 16.7, hw, cfg: { quant: 'UD-IQ3_XXS' }, gpuAvgPowerW: 72, gpuAvgUtilPct: 30, modelBytesGB: 76.3 });
  assert.strictEqual(v.bottleneck, 'ram_bandwidth', v.bottleneck);
  // 3.6까지 올리면 RAM을 넘어 용량 병목이 된다.
  const v2 = bench.computeVerdict({ genTokPerSec: 16.7, hw, cfg: { quant: 'UD-IQ3_XXS' }, gpuAvgPowerW: 72, gpuAvgUtilPct: 30, modelBytesGB: 97.2 });
  assert.strictEqual(v2.bottleneck, 'ram_capacity', v2.bottleneck);

  // 5) WireGuard 설정 글에 필요한 줄이 다 들어가는지 본다.
  const wg = require('../src/wireguard.js');
  const st = { server: { privateKey: 'SPRIV', publicKey: 'SPUB', address: '10.66.0.1', port: 51820 }, peers: [], endpoint: '' };
  const peer = { name: 'pc', address: '10.66.0.2', privateKey: 'PPRIV', publicKey: 'PPUB' };
  st.peers.push(peer);
  const sc = wg.serverConf(st);
  assert.ok(sc.includes('ListenPort = 51820'), sc);
  assert.ok(sc.includes('AllowedIPs = 10.66.0.2/32'), sc);
  const cc = wg.clientConf(st, peer, '203.0.113.7');
  assert.ok(cc.includes('Endpoint = 203.0.113.7:51820'), cc);
  assert.ok(cc.includes('AllowedIPs = 10.66.0.0/24'), cc);
  // 서버 개인 키가 클라이언트 설정에 섞이면 안 된다.
  assert.ok(!cc.includes('SPRIV'), '서버 개인 키가 새어 나갔다');
  assert.strictEqual(wg.nextAddress(st), '10.66.0.3');

  // 6) 초대 코드 파서가 이상한 값을 거른다.
  const good = {
    name: 'pc', address: '10.66.0.2', subnet: '10.66.0.0/24',
    privateKey: 'A'.repeat(43) + '=', serverPublicKey: 'B'.repeat(43) + '=',
    serverAddress: '10.66.0.1', endpoint: '192.168.0.74:51820', apiKey: 'abc12345'
  };
  const enc = (o) => 'LLMB1.' + Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.strictEqual(wg.parseInvite(enc(good)).address, '10.66.0.2');
  const bad = (patch) => {
    assert.throws(() => wg.parseInvite(enc(Object.assign({}, good, patch))));
  };
  bad({ serverAddress: 'evil.example.com' });
  bad({ address: '10.66.0.2\nPostUp = calc.exe' });
  bad({ endpoint: '192.168.0.74' });
  bad({ apiKey: 'a b' });
  bad({ privateKey: 'short' });

  console.log('통과');
})().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
