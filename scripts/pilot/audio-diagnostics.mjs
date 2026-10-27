// Numeric-only metadata for the local fixture. Never returns or retains samples.
export function inspectFixtureWav(body) {
  const start=body.indexOf(Buffer.from('RIFF'));
  if(start<0 || start+44>body.length || body.toString('ascii',start+8,start+12)!=='WAVE') return null;
  const end=start+8+body.readUInt32LE(start+4);
  if(end>body.length || end<start+44) return null;
  let format, data;
  for(let at=start+12;at+8<=end;){
    const type=body.toString('ascii',at,at+4),length=body.readUInt32LE(at+4),next=at+8+length;
    if(next>end) return null;
    if(type==='fmt ' && length>=16) format={encoding:body.readUInt16LE(at+8),channels:body.readUInt16LE(at+10),sampleRate:body.readUInt32LE(at+12),bits:body.readUInt16LE(at+22)};
    if(type==='data') data={at:at+8,length};
    at=next+(length%2);
  }
  if(!format || !data || format.encoding!==1 || format.bits!==16 || ![1,2].includes(format.channels) || format.sampleRate<8000 || format.sampleRate>96000 || data.length%(2*format.channels)) return null;
  let peak=0,sum=0;
  for(let at=data.at;at<data.at+data.length;at+=2){const value=body.readInt16LE(at)/32768;peak=Math.max(peak,Math.abs(value));sum+=value*value;}
  const samples=data.length/2;
  return {wavBytes:end-start,frames:samples/format.channels,sampleRate:format.sampleRate,channels:format.channels,durationMs:Math.round(samples/format.channels/format.sampleRate*1000),peak:Number(peak.toFixed(6)),rms:Number((samples?Math.sqrt(sum/samples):0).toFixed(6))};
}
