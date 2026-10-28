/** Bounded chronological output with absolute byte offsets, shared by observers and tools. */
export class CommandOutput {
  constructor(limit = 256 * 1024) { this.limit = limit; this.total = 0; this.chunks = []; this.bytes = 0; }
  append(channel, value) {
    const data = Buffer.from(value);
    if (!data.length) return;
    this.chunks.push({channel, data, from:this.total}); this.total += data.length; this.bytes += data.length;
    while (this.bytes > this.limit) {
      const first = this.chunks[0], excess = this.bytes - this.limit;
      if (first.data.length <= excess) { this.bytes -= first.data.length; this.chunks.shift(); }
      else { first.data = first.data.subarray(excess); first.from += excess; this.bytes -= excess; }
    }
  }
  tail(maxBytes=2000) {
    const selected=[];let size=0;
    for(let i=this.chunks.length-1;i>=0&&size<maxBytes;i--){const data=this.chunks[i].data.subarray(-Math.max(0,maxBytes-size));selected.unshift(data);size+=data.length;}
    const data=Buffer.concat(selected);let start=0;while(start<data.length&&(data[start]&0xc0)===0x80)start++;
    return data.subarray(start).toString('utf8');
  }
  text(channel) {
    const bytes=Buffer.concat(this.chunks.filter(c => !channel || c.channel === channel).map(c => c.data));
    let start=0;while(start<bytes.length&&(bytes[start]&0xc0)===0x80)start++;
    return bytes.subarray(start).toString('utf8');
  }
  read(from = 0, maxBytes = 16000) {
    const earliest = this.total - this.bytes;
    if (!Number.isSafeInteger(from) || from < 0 || from > this.total) throw new Error('输出偏移无效');
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('输出长度无效');
    const retained=Buffer.concat(this.chunks.map(c=>c.data));
    let offset=Math.max(from,earliest)-earliest;
    while(offset<retained.length&&(retained[offset]&0xc0)===0x80)offset++;
    const start=earliest+offset,end=Math.min(this.total,start+Math.max(4,Math.min(64000,maxBytes)));
    const bytes=retained.subarray(offset,end-earliest);const left=0;let right=bytes.length;
    let lead=right-1;while(lead>=left&&(bytes[lead]&0xc0)===0x80)lead--;
    const size=lead<left?0:bytes[lead]>=0xf0?4:bytes[lead]>=0xe0?3:bytes[lead]>=0xc0?2:1;
    if(lead>=left&&right-lead<size)right=lead;
    return {text:bytes.subarray(left,right).toString('utf8'),from:start+left,next:start+right,total:this.total,earliest,lossy:from < earliest};
  }
}
