const os = require('os')
const { isIPv4 } = require('net')

// libuv reports interfaces that are up (and running on Unix). An active tunnel
// can still be unreachable by a LAN phone, so exclude recognizable adapters.
const VIRTUAL = /wintun|wireguard|tailscale|vpn|tunnel|zerotier|hamachi|anyconnect|fortinet|forticlient|nordlynx|mullvad|proton|surfshark|expressvpn|cloudflare|warp|vbox|virtualbox|vmware|vmnet|vethernet|hyper-v|docker|podman|waydroid|lxcbr|lxdbr|incusbr|flannel|wsl|virtual|teredo|isatap|6to4|iphttps|loopback|^(?:veth[\da-f]+|br-[\da-f]+|zt[\da-z]+|cni\d*)$|(^|[\s_-])(?:utun|tun|tap|ppp|wg|ipsec|virbr|veth|br|cni)[\d_-]*(?:$|[\s_-])/i
const PHYSICAL = /ethernet|wi[ -]?fi|wireless|local area connection|^(?:eth\d|en\d|en[opsx]|wl[anopsx]|wlan)/i
// A Hyper-V external switch can hold the host's actual LAN address.
const EXTERNAL_BRIDGE = /^vEthernet\s*\(External(?: Switch)?\)$/i
const privateIPv4 = ip => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ip)
const carrierShared = ip => {
  const [a, b] = ip.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}

function lanInterfaces(interfaces = os.networkInterfaces()) {
  const candidates = []
  const seen = new Set()
  for (const [name, entries] of Object.entries(interfaces || {})) {
    if (VIRTUAL.test(name) && !EXTERNAL_BRIDGE.test(name)) continue
    for (const entry of entries || []) {
      const address = entry?.address
      if (!entry || entry.internal || !['IPv4', 4].includes(entry.family) || !isIPv4(address || '')) continue
      const first = Number(address.split('.')[0])
      if (first === 0 || first === 127 || first >= 224 || address.startsWith('169.254.')) continue
      // Renamed TUN adapters may look like Ethernet. Host-only /32 addresses
      // and the 198.18/15 benchmark range are not ordinary LAN endpoints.
      if (entry.netmask === '255.255.255.255' || /^198\.(?:18|19)\./.test(address)) continue
      candidates.push({ ...entry, name, address })
    }
  }
  // Hidden overlays can use 100.64/10. Omit those alongside normal LANs,
  // while retaining genuine carrier-shared LANs when they are the only option.
  const local = candidates.filter(entry => !carrierShared(entry.address))
  return (local.length ? local : candidates).sort((a, b) =>
    Number(!PHYSICAL.test(a.name)) - Number(!PHYSICAL.test(b.name)) ||
    Number(!privateIPv4(a.address)) - Number(!privateIPv4(b.address))).filter(entry => {
      if (seen.has(entry.address)) return false
      seen.add(entry.address)
      return true
    })
}

module.exports = { lanInterfaces }
