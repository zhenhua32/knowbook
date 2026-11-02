import { serializeMarkdownWithBlockRanges } from '../../shared/markdown'
import { collectStoredMarkdownAssetDestinations, parseSyncedPortableAssetUri } from '../../shared/syncedBlockPortable'
import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { graph3Rows } from './restore-knowledge-graph3-data'
import { validateExchangeJob, validateExchangeReceipt, parseExchangeStored, exchangeJobKey, exchangeJobHash } from '../sync/synced-exchange-model'
import { publicationHash, publicationJson } from '../sync/synced-publication-model'
import { root3SupplementOriginalRowHash3, root3SupplementSourceContentHash3, root3CustomMergeParts3, type Root3SettledWorkingEvidence3 } from './restore-knowledge-assets3-context'
import { root4SettledPortableMappingsForMain5 } from './restore-knowledge-assets4-supplement'
import type { readCapsule2BaseProjectionOriginalInput5 as readCapsule2BaseProjection4 } from './restore-knowledge-capsule2-base-projection4'
import type { deriveCapsule2WorkingPortableEvidence5 } from './restore-knowledge-assets5-working-portable-derive'
import type { replayRoot5WorkingMergeContext5 } from './restore-knowledge-assets5-working-context'
type Base = Awaited<ReturnType<typeof readCapsule2BaseProjection4>>
type Automatic = ReturnType<typeof deriveCapsule2WorkingPortableEvidence5>
type Replay = ReturnType<typeof replayRoot5WorkingMergeContext5>
type RawRow = ReturnType<typeof graph3Rows>[number]
const hash=(domain:string,value:unknown)=>capsuleBytesHash(domain+'\0'+capsuleJson(value))
const same=(a:unknown,b:unknown)=>publicationJson(a)===publicationJson(b)
const fail=(reason:string):never=>{throw new Error('automatic scopes5: '+reason)}
const opaque=new Set(['code','code-block','math','frontmatter','database-view','synced-block'])
export interface Root5WorkingScope5 {
  readonly family:2|3|4|5|6|7
  readonly source: readonly string[]; readonly contentHash:string; readonly bodyProjectionHash:string
  readonly jobSettingKey:string; readonly jobHash:string; readonly contextHash:string; readonly recordKey:string; readonly resultHash:string
  readonly evidenceKind:'replayed-original-working-inputs'|'settled-original-working-record'
  readonly destinations:readonly {readonly section:'summary'|'body';readonly uri:string;readonly raw:string;readonly from:number;readonly to:number;readonly kind:string;readonly syntax:string}[]
}
export function createRoot5WorkingScopeObserver5(base:Base, automatic:Automatic) {
  const raw=base.sourceContent, holders=new Map<string,Array<{row:RawRow;source:string[];kind:'job'|'receipt'}>>()
  for(const row of graph3Rows(raw,'app_settings'))if(typeof row.value.key==='string'&&row.value.key.startsWith('sync.webdav.protocol5.exchange-job.v1.')&&typeof row.value.value==='string'){
    const job=validateExchangeJob(parseExchangeStored(row.value.value));if(job.version===1||!job.merges?.length&&!root3CustomMergeParts3(job.request).length)continue
    if(row.value.key!==exchangeJobKey(job.request.operationId,job.attemptId))return fail('original job key mismatch')
    holders.set(row.value.key,[{row,source:['app_settings',row.value.key,'value'],kind:'job'}])
  }
  for(const row of graph3Rows(raw,'synced_operations'))if(typeof row.value.result_json==='string'){
    const value=parseExchangeStored(row.value.result_json)
    if(!value||typeof value!=='object'||!('kind'in value)||value.kind!=='synced-exchange-operation')continue
    const receipt=validateExchangeReceipt(value);if(receipt.version===1||!receipt.provenance.merges?.length&&!root3CustomMergeParts3(receipt.request).length)continue
    const key=receipt.provenance.attemptId?exchangeJobKey(receipt.request.operationId,receipt.provenance.attemptId):'@receipt-without-attempt:'+receipt.request.operationId,list=holders.get(key)??[]
    list.push({row,source:['synced_operations',String(row.value.client_operation_id),'result_json'],kind:'receipt'})
    holders.set(key,list)
  }
  const scopes:Root5WorkingScope5[]=[],pendingPortableBindings:Array<{scopeSource:readonly string[];section:'summary'|'body';from:number;to:number;sourceUri:string;hash:string;name:string;bytes:number;contextHash:string;descriptorHash:string}>=[]
  const settledPortableBindings:Array<ReturnType<typeof root4SettledPortableMappingsForMain5>[number]&{scopeSource:readonly string[];section:'summary'|'body';from:number;to:number;resultHash:string;contextHash:string;recordKey:string}>=[]
  const unsupportedHolders:Array<{source:readonly string[];originalRowHash:string;jobSettingKey:string;reason:'original-automatic-W-not-reconstructable'}>=[],seen=new Set<string>()
  let finished=false
  const accept=(evidence:Root3SettledWorkingEvidence3|Replay,replayed:boolean)=>{
    if(finished)return fail('observer already finished')
    const key=exchangeJobKey(evidence.job.request.operationId,evidence.job.attemptId),originals=holders.get(key)
    if(!originals||seen.has(key)||evidence.job.version===1)return fail('unrequested or repeated automatic W')
    const originalHolder=originals.find(value=>value.kind==='job');if(!originalHolder)return fail('selected automatic W has no original SQL job')
    const original=validateExchangeJob(parseExchangeStored(String(originalHolder.row.value.value)))
    if(!same(original,evidence.job)||evidence.merged.length!==original.merges?.length)return fail('automatic W job differs from original SQL')
    const pending=new Map(evidence.job.descriptor.next.assets.flatMap(asset=>asset.names.map(name=>[capsuleJson([asset.hash,name]),asset]as const)))
    for(const holder of originals){
      if(holder.kind==='receipt'){
        const receipt=validateExchangeReceipt(parseExchangeStored(String(holder.row.value.result_json)))
        if(!same(receipt.request,evidence.job.request)||receipt.provenance.planHash!==evidence.job.descriptor.planHash||!same(receipt.provenance.merges,evidence.job.merges))return fail('receipt differs from original automatic W')
      }
      for(const item of evidence.merged){
        const provenance=evidence.job.merges?.find(value=>value.key===item.recordKey)
        if(!provenance||!same(provenance,item.provenance)||publicationHash(publicationJson(item.record))!==provenance.resultHash)return fail('whole automatic W/result hash mismatch')
        if(item.record.kind!=='document'&&item.record.kind!=='synced-group')return fail('automatic W is not a live typed record')
        const source=['root5-merge-working-scope-v1',...holder.source,'merges',item.recordKey,'working-record']
        const binding={family:evidence.job.version,source:holder.source,originalRowHash:root3SupplementOriginalRowHash3(raw,holder.row),jobSettingKey:key,jobHash:exchangeJobHash(evidence.job),contextHash:evidence.contextHash,
          recordKey:item.recordKey,resultHash:provenance.resultHash,baseManifestHash:base.commitment.baseManifestHash,workingEvidenceHash:automatic.evidenceHash}
        const body=item.record.kind==='document'?item.record.content:{summary:'',blocks:item.record.blocks}
        const markdown=serializeMarkdownWithBlockRanges(body.blocks.map(block=>opaque.has(block.type)?{...block,type:'paragraph',content:''}:block)as SyncedStableBlockDraft[]).markdown
        const destinations:Root5WorkingScope5['destinations'][number][]=[],mappings=replayed?[]:'binding' in evidence
          ?root4SettledPortableMappingsForMain5(base,evidence,item.recordKey):fail('settled W lacks its original portable binding')
        for(const[section,text]of[['summary',body.summary],['body',markdown]]as const)for(const destination of collectStoredMarkdownAssetDestinations(text)){
          destinations.push({section,uri:destination.url,raw:text.slice(destination.start,destination.end),from:destination.start,to:destination.end,kind:destination.kind,syntax:destination.syntax??'markdown'})
          if(!destination.url.startsWith('knowbook-asset://'))continue
          const asset=parseSyncedPortableAssetUri(destination.url),entry=pending.get(capsuleJson([asset.hash,asset.name]))
          if(replayed&&entry)pendingPortableBindings.push({scopeSource:source,section,from:destination.start,to:destination.end,sourceUri:destination.url,hash:entry.hash,name:asset.name,bytes:entry.bytes,
            contextHash:evidence.contextHash,descriptorHash:publicationHash(publicationJson(evidence.job.descriptor))})
          for(const mapping of mappings)if(mapping.portableUri===destination.url)settledPortableBindings.push({...mapping,scopeSource:source,section,from:destination.start,to:destination.end,
            recordKey:item.recordKey,resultHash:provenance.resultHash,contextHash:evidence.contextHash})
        }
        scopes.push({family:evidence.job.version,source,contentHash:hash('knowbook.restore.assets5.merge-scope-content.v1',{binding,body}),bodyProjectionHash:hash('knowbook.restore.assets5.merge-body-projection.v1',{binding,markdown}),
          jobSettingKey:key,jobHash:binding.jobHash,contextHash:evidence.contextHash,recordKey:item.recordKey,resultHash:provenance.resultHash,
          evidenceKind:replayed?'replayed-original-working-inputs':'settled-original-working-record',destinations})
      }
    }
    seen.add(key)
  }
  const jobs=new Map(graph3Rows(raw,'app_settings').filter(row=>typeof row.value.key==='string').map(row=>[String(row.value.key),row]))
  for(const value of automatic.jobs){const row=jobs.get(value.jobSettingKey);if(!row)return fail('settled automatic job absent')
    const job=validateExchangeJob(parseExchangeStored(String(row.value.value)));if(exchangeJobHash(job)!==value.jobHash)return fail('settled job hash mismatch')
    accept({job,merged:value.merged,contextHash:value.contextHash,binding:value.binding},false)
  }
  return {accept:(replay:Replay)=>accept(replay,true),finish:()=>{
    if(finished)return fail('observer already finished');finished=true
    if(root3SupplementSourceContentHash3(raw)!==base.commitment.sourceContentHash)return fail('same-read raw SQL changed during automatic observation')
    for(const[key,values]of holders)if(!seen.has(key))for(const holder of values)unsupportedHolders.push({source:holder.source,originalRowHash:root3SupplementOriginalRowHash3(raw,holder.row),jobSettingKey:key,reason:'original-automatic-W-not-reconstructable'})
    scopes.sort((a,b)=>capsuleJson(a.source)<capsuleJson(b.source)?-1:1)
    const body={kind:'root5-merge-working-scopes' as const,version:3 as const,scope:'all-original-merge-working-records' as const,
      sourceContentHash:base.commitment.sourceContentHash,baseManifestHash:base.commitment.baseManifestHash,workingEvidenceHash:automatic.evidenceHash,
      scopes,pendingPortableBindings,settledPortableBindings,unsupportedHolders,mergeWorkingScopesCaptured:unsupportedHolders.length===0,
      allAssetScopesCaptured:false as const,otherHeldPayloadScopesComplete:false as const,acceptedCoverage:false as const,effective:false as const,installPermit:false as const}
    return freezeCapsuleValue({...body,observationHash:hash('knowbook.restore.assets5.merge-observation.v1',body)})
  }}
}
