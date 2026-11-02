import assert from 'node:assert/strict'
import test from 'node:test'
import {capsuleJson} from '../src/main/database/restore-knowledge-capsule-model'
import {capsule5TransportFiles} from '../src/main/database/restore-knowledge-capsule5-transport-model'
import type {Capsule2AssetArchiveManifest} from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import {describeWorkingOriginals5,parseWorkingOriginals5,type WorkingOriginalsManifest5} from '../src/main/database/restore-knowledge-capsule5-working-model'
import {withPendingWorkingSource5} from './helpers/working5-automatic-source-fixture'

test('archive5 transport refuses missing or re-signed foreign working index commitments while keeping genuine complete inventory',()=>withPendingWorkingSource5(async f=>{
  const archive=f.value.assetArchive;assert.equal(archive.version,5)
  if(archive.version!==5)throw Error('Genuine archive5 required')
  const assets=`catalog/backups/database-restore/${f.sourceInput.operationId}/knowledge-complete-assets-v2/${f.sourceInput.capsuleId}`
  const text=capsuleJson(f.working.manifest)+'\n',files=capsule5TransportFiles(archive,assets,text)
  assert.equal(files.length,f.working.manifest.files.length+1)
  assert.equal(files[0].path,assets+'/contexts/manifest.json')
  assert.equal(files.reduce((n,file)=>n+file.bytes,0),archive.workingOriginals.originalFileBytes+archive.workingOriginals.manifestFile.bytes)
  assert.throws(()=>capsule5TransportFiles(archive,assets),'Full inventory cannot infer the missing exact index from a pointer')
  const changedHash=(hash:string)=>hash=== 'e'.repeat(64)?'d'.repeat(64):'e'.repeat(64)
  const cases:WorkingOriginalsManifest5[]=[
    {...f.working.manifest,sourceContentHash:changedHash(f.working.manifest.sourceContentHash)},
    {...f.working.manifest,baseProjection:{...f.working.manifest.baseProjection,baseManifestHash:changedHash(f.working.manifest.baseProjection.baseManifestHash)}},
    {...f.working.manifest,workingEvidenceHash:changedHash(f.working.manifest.workingEvidenceHash)},
    {...f.working.manifest,observation:{...f.working.manifest.observation,hash:changedHash(f.working.manifest.observation.hash)}},
    {...f.working.manifest,observation:{...f.working.manifest.observation,scopeCount:f.working.manifest.observation.scopeCount+1}},
    {...f.working.manifest,observation:{...f.working.manifest.observation,unsupportedHolders:f.working.manifest.observation.unsupportedHolders+1}}
  ]
  for(const changed of cases){
    const resigned:Extract<Capsule2AssetArchiveManifest,{version:5}>={...archive,workingOriginals:describeWorkingOriginals5(changed)}
    const resignedText=capsuleJson(changed)+'\n'
    assert.deepEqual(parseWorkingOriginals5(resignedText,resigned.workingOriginals),changed,'The independent original grammar and complete re-signed pointer must pass before the transport join rejects it')
    assert.throws(()=>capsule5TransportFiles(resigned,assets,resignedText),'A self-consistent raw/domain/index pointer cannot replace this source/base/observer commitment')
  }
  assert.equal(archive.coverage.allAssetScopesCaptured,false);assert.equal(archive.coverage.installPermit,false)
}))
