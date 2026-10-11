import net from 'node:net';
export async function pipeRequest(message,{path=process.env.CODEX_APP_TOOLS_PIPE_PATH,timeoutMs=15000}={}){
 if(!path)throw Error('Desktop app tools endpoint is unavailable');
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection(path);let data=Buffer.alloc(0),done=false,submitted=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();if(error){error.noSubmission=!submitted;reject(error);}else resolve(value);};
  const timer=setTimeout(()=>finish(Error('Desktop app tools response timed out')),timeoutMs);
  socket.on('error',()=>finish(Error('Desktop app tools connection failed')));
  socket.on('connect',()=>{const body=Buffer.from(JSON.stringify(message));const header=Buffer.alloc(4);header.writeUInt32LE(body.length);submitted=true;socket.write(Buffer.concat([header,body]));});
  socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);while(data.length>=4){const size=data.readUInt32LE(0);if(size>8*1024*1024){finish(Error('Oversized desktop reply'));return;}if(data.length<size+4)return;let reply;try{reply=JSON.parse(data.subarray(4,size+4));}catch{finish(Error('Invalid desktop reply'));return;}data=data.subarray(size+4);if(reply.id===message.id){finish(null,reply);return;}}});
  socket.on('close',()=>{if(!done)finish(Error('Desktop pipe closed before response'));});
 });
}
