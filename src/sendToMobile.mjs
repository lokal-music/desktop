export function transferableTracks(tracks) {
  const seen = new Set()
  return (Array.isArray(tracks) ? tracks : []).filter(track => {
    const id = String(track?.id ?? '').trim()
    const filePath = String(track?.file_path ?? '').trim()
    if (!id || !filePath || /^ghost:\/\//i.test(filePath) || track?.missing || seen.has(id)) return false
    seen.add(id)
    return true
  }).map(track => ({ ...track, id: String(track.id).trim() }))
}

export function connectedPhones(devices) {
  return (Array.isArray(devices) ? devices : []).filter(device =>
    typeof device?.id === 'string' && device.id.trim() && device.connected && !device.revoked
  )
}

export async function sendTracksToPhone(electron, deviceId, tracks, onProgress) {
  const ids = transferableTracks(tracks).map(track => track.id)
  if (!ids.length) throw new Error('No local songs are available to send.')
  if (!electron?.commandLinkDevice || !deviceId) throw new Error('Phone transfer is unavailable.')

  const total = ids.length
  const batches = Math.ceil(total / 100)
  let completed = 0
  for (let index = 0; index < batches; index++) {
    onProgress?.({ completed, total, batch: index + 1, batches })
    const tracksInBatch = ids.slice(index * 100, (index + 1) * 100)
    let result
    try {
      result = await electron.commandLinkDevice(deviceId, {
        action: 'copyTracksToPhone',
        value: { tracks: tracksInBatch },
      })
    } catch (error) {
      const failure = new Error(error?.message || 'The phone did not respond.')
      failure.copied = completed
      throw failure
    }
    if (result?.ok !== true) {
      const failure = new Error(result?.error || 'The phone could not copy the selected songs.')
      failure.copied = completed
      throw failure
    }
    completed += tracksInBatch.length
    onProgress?.({ completed, total, batch: index + 1, batches })
  }
  return { copied: completed }
}
