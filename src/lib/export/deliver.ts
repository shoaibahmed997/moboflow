// Browser delivery: clipboard, file download, Web Share. Each returns an outcome rather
// than throwing for expected cases (user cancelled the share sheet, API unsupported) so
// callers can show the right feedback without try/catch boilerplate.

export type DeliveryOutcome = 'done' | 'cancelled' | 'unsupported' | 'failed'

export async function copyText(text: string): Promise<DeliveryOutcome> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return 'done'
    }
  } catch {
    // Permission denied or document not focused — fall through to the legacy path.
  }
  // Legacy fallback for contexts without the async Clipboard API (older WebViews).
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy') ? 'done' : 'failed'
  } catch {
    return 'failed'
  } finally {
    textarea.remove()
  }
}

const MIME = { txt: 'text/plain', md: 'text/markdown' } as const

function toFile(text: string, filename: string): File {
  const extension = filename.endsWith('.md') ? 'md' : 'txt'
  return new File([text], filename, { type: `${MIME[extension]};charset=utf-8` })
}

export function downloadText(text: string, filename: string): DeliveryOutcome {
  const url = URL.createObjectURL(toFile(text, filename))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoke on a delay: some browsers (notably iOS Safari) read the blob asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return 'done'
}

export const canShare = (): boolean => typeof navigator !== 'undefined' && typeof navigator.share === 'function'

/**
 * Whether the share sheet accepts files here — Android Chrome does; desktop and iOS
 * support varies. Probed with a real File, as canShare() checks type support.
 */
export function canShareFiles(): boolean {
  if (!canShare() || typeof navigator.canShare !== 'function') return false
  try {
    return navigator.canShare({ files: [toFile('', 'probe.md')] })
  } catch {
    return false
  }
}

async function share(data: ShareData): Promise<DeliveryOutcome> {
  if (!canShare()) return 'unsupported'
  try {
    await navigator.share(data)
    return 'done'
  } catch (err) {
    // AbortError = the user dismissed the share sheet; not a failure worth reporting.
    return err instanceof DOMException && err.name === 'AbortError' ? 'cancelled' : 'failed'
  }
}

export function shareText(title: string, text: string): Promise<DeliveryOutcome> {
  return share({ title, text })
}

export function shareFile(title: string, text: string, filename: string): Promise<DeliveryOutcome> {
  if (!canShareFiles()) return Promise.resolve('unsupported')
  return share({ title, files: [toFile(text, filename)] })
}
