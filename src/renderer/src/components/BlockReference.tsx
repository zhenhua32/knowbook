import { useEffect, useState } from 'react'
import type { BlockReferenceResult } from '@shared/contracts'

export function CrossDocumentBlockReference({ documentPath, blockId }: { documentPath: string; blockId: string }) {
  const [blockRef, setBlockRef] = useState<BlockReferenceResult | null>(null)

  useEffect(() => {
    let cancelled = false
    setBlockRef(null)
    void window.knowbook.getBlockReference(documentPath, blockId).then((result) => {
      if (!cancelled) {
        setBlockRef(result)
      }
    }).catch((error) => {
      if (!cancelled) {
        console.warn('Failed to resolve cross-document block reference.', error)
      }
    })

    return () => {
      cancelled = true
    }
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
