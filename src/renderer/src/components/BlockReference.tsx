import { useEffect, useState } from 'react'
import type { BlockReferenceResult } from '@shared/contracts'

export function CrossDocumentBlockReference({ documentPath, blockId }: { documentPath: string; blockId: string }) {
  const [blockRef, setBlockRef] = useState<BlockReferenceResult | null>(null)

  useEffect(() => {
    window.knowbook.getBlockReference(documentPath, blockId).then(setBlockRef)
  }, [documentPath, blockId])

  if (!blockRef) {
    return <span>[[{documentPath}#{blockId}]]</span>
  }

  return (
    <span className="inline-link-block" title={`${blockRef.documentTitle} - ${blockRef.block.content}`}>
      [[{blockRef.documentTitle}#{blockId}]]
    </span>
  )
}
