'use strict';
// 실행 파일 이름으로 어느 앱인지 고른다. 한 코드에서 exe 두 개가 나온다.
// llmbench-client.exe면 클라이언트, 그 밖이면 서버 앱이다.
// 개발 중에는 LLMBENCH_ROLE=client로 바꿔 띄운다.

const path = require('path');

const exeName = path.basename(process.execPath).toLowerCase();
const role = process.env.LLMBENCH_ROLE || (exeName.includes('llmbench-client') ? 'client' : 'server');

if (role === 'client') {
  require('./client/main.js');
} else {
  require('./main.js');
}
