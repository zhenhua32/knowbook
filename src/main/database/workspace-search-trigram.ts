// Generated from the installed, lockfile-pinned SQLite 3.49.2 FTS5 UnicodeFold.
// Public-domain SQLite source; remove_diacritics=0, matching schema27 trigram.
// Native function SHA256: 84596aa9faf17792197c9f4f426806e46409cab65f20d4f8a9daf61236855d8b
export const sqliteTrigramFoldSource={version:"3.49.2",functionSha256:"84596aa9faf17792197c9f4f426806e46409cab65f20d4f8a9daf61236855d8b"} as const
const entries:readonly(readonly[number,number,number])[]=[
  [65,14,26],
  [181,64,1],
  [192,14,23],
  [216,14,7],
  [256,1,48],
  [306,1,6],
  [313,1,16],
  [330,1,46],
  [376,116,1],
  [377,1,6],
  [383,104,1],
  [385,50,1],
  [386,1,4],
  [390,44,1],
  [391,0,1],
  [393,42,2],
  [395,0,1],
  [398,32,1],
  [399,38,1],
  [400,40,1],
  [401,0,1],
  [403,42,1],
  [404,46,1],
  [406,52,1],
  [407,48,1],
  [408,0,1],
  [412,52,1],
  [413,54,1],
  [415,56,1],
  [416,1,6],
  [422,60,1],
  [423,0,1],
  [425,60,1],
  [428,0,1],
  [430,60,1],
  [431,0,1],
  [433,58,2],
  [435,1,4],
  [439,62,1],
  [440,0,1],
  [444,0,1],
  [452,2,1],
  [453,0,1],
  [455,2,1],
  [456,0,1],
  [458,2,1],
  [459,1,18],
  [478,1,18],
  [497,2,1],
  [498,1,4],
  [502,122,1],
  [503,134,1],
  [504,1,40],
  [544,110,1],
  [546,1,18],
  [570,70,1],
  [571,0,1],
  [573,108,1],
  [574,68,1],
  [577,0,1],
  [579,106,1],
  [580,28,1],
  [581,30,1],
  [582,1,10],
  [837,36,1],
  [880,1,4],
  [886,0,1],
  [902,18,1],
  [904,16,3],
  [908,26,1],
  [910,24,2],
  [913,14,17],
  [931,14,9],
  [962,0,1],
  [975,4,1],
  [976,140,1],
  [977,142,1],
  [981,146,1],
  [982,144,1],
  [984,1,24],
  [1008,136,1],
  [1009,138,1],
  [1012,130,1],
  [1013,128,1],
  [1015,0,1],
  [1017,152,1],
  [1018,0,1],
  [1021,110,3],
  [1024,34,16],
  [1040,14,32],
  [1120,1,34],
  [1162,1,54],
  [1216,6,1],
  [1217,1,14],
  [1232,1,88],
  [1329,22,38],
  [4256,66,38],
  [4295,66,1],
  [4301,66,1],
  [7680,1,150],
  [7835,132,1],
  [7838,96,1],
  [7840,1,96],
  [7944,150,8],
  [7960,150,6],
  [7976,150,8],
  [7992,150,8],
  [8008,150,6],
  [8025,151,8],
  [8040,150,8],
  [8072,150,8],
  [8088,150,8],
  [8104,150,8],
  [8120,150,2],
  [8122,126,2],
  [8124,148,1],
  [8126,100,1],
  [8136,124,4],
  [8140,148,1],
  [8152,150,2],
  [8154,120,2],
  [8168,150,2],
  [8170,118,2],
  [8172,152,1],
  [8184,112,2],
  [8186,114,2],
  [8188,148,1],
  [8486,98,1],
  [8490,92,1],
  [8491,94,1],
  [8498,12,1],
  [8544,8,16],
  [8579,0,1],
  [9398,10,26],
  [11264,22,47],
  [11360,0,1],
  [11362,88,1],
  [11363,102,1],
  [11364,90,1],
  [11367,1,6],
  [11373,84,1],
  [11374,86,1],
  [11375,80,1],
  [11376,82,1],
  [11378,0,1],
  [11381,0,1],
  [11390,78,2],
  [11392,1,100],
  [11499,1,4],
  [11506,0,1],
  [42560,1,46],
  [42624,1,24],
  [42786,1,14],
  [42802,1,62],
  [42873,1,4],
  [42877,76,1],
  [42878,1,10],
  [42891,0,1],
  [42893,74,1],
  [42896,1,4],
  [42912,1,10],
  [42922,72,1],
  [65313,14,26]
]
const offsets:readonly number[]=[1,2,8,15,16,26,28,32,37,38,40,48,63,64,69,71,79,80,116,202,203,205,206,207,209,210,211,213,214,217,218,219,775,7264,10792,10795,23228,23256,30204,54721,54753,54754,54756,54787,54793,54809,57153,57274,57921,58019,58363,61722,65268,65341,65373,65406,65408,65410,65415,65424,65436,65439,65450,65462,65472,65476,65478,65480,65482,65488,65506,65511,65514,65521,65527,65528,65529]
function fold(code:number):number {
  if(code<128)return code>=65&&code<=90?code+32:code
  if(code>=66560&&code<66600)return code+40
  if(code>=65536)return code
  let low=0,high=entries.length-1,found=0
  while(low<=high){const middle=(low+high)>>>1;if(code>=entries[middle][0]){found=middle;low=middle+1}else high=middle-1}
  const[start,flags,length]=entries[found]
  return code<start+length&&(1&flags&(start^code))===0?(code+offsets[flags>>>1])&65535:code
}
export function foldSqliteTrigramText(text:string):string {
  if(/^[\x00-\x7f]*$/.test(text))return text.replace(/\0/g,'').toLowerCase()
  // Match the native UTF8 bind conversion, including lone JS surrogates. FTS5
  // skips U+0000 while forming adjacent trigrams; SQL LIKE handles short terms.
  const native=Buffer.from(text,'utf8').toString('utf8'),chunk=new Uint16Array(4096),parts:string[]=[]
  let used=0
  const append=(unit:number)=>{chunk[used++]=unit;if(used===chunk.length){parts.push(String.fromCharCode(...chunk));used=0}}
  for(let offset=0;offset<native.length;offset++){
    let code=native.codePointAt(offset)!;if(code>65535)offset++;if(code===0)continue;code=fold(code)
    if(code>65535){code-=65536;append(55296+(code>>>10));append(56320+(code&1023))}else append(code)
  }
  if(used)parts.push(String.fromCharCode(...chunk.subarray(0,used)))
  return parts.join('')
}
export function sqliteTrigramLiteralContains(content:string,term:string):boolean {
  const folded=foldSqliteTrigramText(term)
  return [...folded].length>=3&&foldSqliteTrigramText(content).includes(folded)
}
export function sqliteTrigramTermsMatch(content:string,terms:readonly string[],any:boolean):boolean {
  const folded=foldSqliteTrigramText(content),needles=terms.map(foldSqliteTrigramText)
  const matches=(needle:string)=>[...needle].length>=3&&folded.includes(needle)
  return any?needles.some(matches):needles.every(matches)
}
/** Presentation only. These UTF16 snippet cuts are never navigation coordinates. */
export function canonicalSearchSnippet(content:string,terms:readonly string[]):string {
  const native=content,folded=terms.some(term=>[...term].length>=3)?foldSqliteTrigramText(native):'',offsets:number[]=[]
  const ascii=(unit:number)=>unit>=65&&unit<=90?unit+32:unit
  for(const term of terms){const value=Buffer.from(term,'utf8').toString('utf8')
    if([...term].length>=3){const point=folded.indexOf(foldSqliteTrigramText(value));if(point<0)continue
      let original=0,count=0
      while(original<native.length&&count<point){if(native.charCodeAt(original)!==0)count++;original++}
      while(original<native.length&&native.charCodeAt(original)===0)original++
      offsets.push(original)
    }else{
      const end=native.indexOf('\0'),limit=end<0?native.length:end
      outer:for(let from=0;from+value.length<=limit;from++){
        for(let offset=0;offset<value.length;offset++)if(ascii(native.charCodeAt(from+offset))!==ascii(value.charCodeAt(offset)))continue outer
        offsets.push(from);break
      }
    }
  }
  let start=Math.max(0,(offsets.length?Math.min(...offsets):0)-40)
  if(start>0&&native.charCodeAt(start)>=56320&&native.charCodeAt(start)<=57343)start--
  let end=Math.min(native.length,start+180)
  if(end<native.length&&native.charCodeAt(end)>=56320&&native.charCodeAt(end)<=57343)end--
  return(start>0?'…':'')+native.slice(start,end)+(native.length>end?'…':'')
}
