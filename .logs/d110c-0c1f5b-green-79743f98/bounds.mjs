import { encodeCanonical } from '../../packages/canonical/dist/src/index.js';
const generous = {maxBytes:1024*1024,maxDepth:16,maxItems:16384};
const bytes = value => encodeCanonical(value,generous).byteLength;
const message = (id,text=id) => ({clientOperationId:id,text});
const operation = (id,n) => ({action:'message',clientOperationId:id,text:'r'.repeat(n)});
const batch = n => ({action:'applicationBatch',batch:{version:1,entries:[0,1].map(i=>({logicalTime:3+2*i,operation:operation('displaced-'+i,n)}))}});
const mainState = n => [message('creator-before-close'),message('writer-before-close'),message('displaced-0','r'.repeat(n)),message('creator-during-writer-crash')];
const mainFinal = n => [...mainState(n),message('displaced-1','r'.repeat(n)),message('after-cold-reopen'),message('creator-cold-reopen'),message('writer-third-reopen')];
const wideState = n => [...Array.from({length:4},(_,e)=>Array.from({length:64},(_,i)=>message(`wide-${e}-${i}`))).flat(),...Array.from({length:3},(_,e)=>[0,1].map(i=>message(`wide-displaced-${e}-${i}`,'r'.repeat(n)))).flat()];
const firstTrue = (predicate) => {let low=0,high=65536;while(low<high){const mid=Math.floor((low+high)/2);if(predicate(mid))high=mid;else low=mid+1;}return low;};
console.log(JSON.stringify({
  measurementOnlyLimits:generous,
  productLimits:{stateBytes:32768,batchBytes:65536},
  at33000:{singleMessageState:bytes([message('displaced-0','r'.repeat(33000))]),twoIntentBatch:bytes(batch(33000)),mainSecondCloseState:bytes(mainState(33000)),mainFinalMessages:bytes(mainFinal(33000)),wideFinal262Messages:bytes(wideState(33000))},
  minimalEqualTextForBatchOverflow:firstTrue(n=>bytes(batch(n))>65536),
  maximumEqualTextWithinState:{mainSecondClose:firstTrue(n=>bytes(mainState(n))>32768)-1,mainFinal:firstTrue(n=>bytes(mainFinal(n))>32768)-1,wideFinal:firstTrue(n=>bytes(wideState(n))>32768)-1},
  proposedSmallTransform256:{mainFinal:bytes(mainFinal(256)),wideFinal:bytes(wideState(256)),batch:bytes(batch(256))},
},null,2));
