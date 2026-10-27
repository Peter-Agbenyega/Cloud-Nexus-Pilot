import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inspectFixtureWav} from './audio-diagnostics.mjs';
function wav(samples=[0,16384,-16384],channels=1){
 const b=Buffer.alloc(44+samples.length*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(channels,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000*channels,28);b.writeUInt16LE(2*channels,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples.length*2,40);samples.forEach((n,i)=>b.writeInt16LE(n,44+i*2));return b;
}
test('multipart WAV inspection produces numeric metadata without returning samples',()=>{
 const metadata=inspectFixtureWav(Buffer.concat([Buffer.from('multipart header\r\n'),wav(),Buffer.from('\r\n--end')]));
 assert.equal(metadata.frames,3);assert.equal(metadata.sampleRate,16000);assert.equal(metadata.peak,0.5);assert.ok(metadata.rms>0);assert.ok(Object.values(metadata).every(v=>typeof v==='number'));assert.equal(metadata.wavBytes,50);
});
test('silence and empty WAV are accurately distinguished from signal',()=>{
 assert.equal(inspectFixtureWav(wav([0,0,0])).rms,0);assert.equal(inspectFixtureWav(wav([])).rms,0);
});
test('malformed, truncated, encoded and invalid-channel input yields no signal claim',()=>{
 for(const b of [Buffer.from('encoded data'),wav().subarray(0,45),wav([0],3)])assert.equal(inspectFixtureWav(b),null);
 const b=wav();b.writeUInt16LE(3,20);assert.equal(inspectFixtureWav(b),null);
});
test('stereo framing and later complete chunks are measured independently',()=>{
 for(let i=0;i<3;i++){const m=inspectFixtureWav(wav([0,8192,-8192,0],2));assert.equal(m.channels,2);assert.equal(m.frames,2);assert.equal(m.peak,0.25);}
});
