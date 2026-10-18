import {createApp} from './server/index.js';
import {createInterface} from 'node:readline';
const instance=createApp();
const server=instance.app.listen(0,'127.0.0.1',()=>{
  console.log('YUNDAIZHANG_READY '+JSON.stringify({url:`http://127.0.0.1:${server.address().port}/`,pid:process.pid,db_path:instance.dbPath}));
});
let closing=false;
function stop(){if(closing)return;closing=true;server.close(()=>{instance.close();process.exit(0);});server.closeIdleConnections();}
server.on('error',error=>{console.error(error.stack);instance.close();process.exit(1);});
const input=createInterface({input:process.stdin,terminal:false});
input.on('line',line=>{if(line==='shutdown')stop();});
input.on('close',stop);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
