const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const { EventEmitter } = require('events')
const { lanInterfaces } = require('../electron/network/lanInterfaces')
const { createMdnsPool } = require('../electron/network/mdns')
const { advertise } = require('../electron/link/discovery')
const { getRemoteConnectionInfo } = require('../electron/ipc/remote')

const ipv4 = address => ({ address, family: 'IPv4', internal: false })
const adapters = () => ({
  Wintun: [ipv4('10.8.0.2')],
  Tailscale: [ipv4('100.100.1.2')],
  'TAP-Windows Adapter V9': [ipv4('10.9.0.2')],
  'vEthernet (WSL)': [ipv4('172.28.64.1')],
  'VMware Network Adapter VMnet1': [ipv4('192.168.56.1')],
  'Wi-Fi': [ipv4('192.168.1.20')],
  Ethernet: [ipv4('10.0.0.9')],
})

test('LAN pairing and QR choose Wi-Fi when tunnels were enumerated first', t => {
  t.mock.method(os, 'networkInterfaces', adapters)
  const info = getRemoteConnectionInfo()
  assert.equal(new URL(info.primary).hostname, '192.168.1.20')
  assert.deepEqual(info.urls.map(value => new URL(value).hostname), ['192.168.1.20', '10.0.0.9'])
  assert.equal(new URL(info.qrUrl).searchParams.get('text'), info.primary)
})

test('Wi-Fi and Ethernet outrank unknown interfaces; bad, duplicate and virtual addresses are omitted', () => {
  const values = lanInterfaces({
    unknown: [ipv4('192.168.1.20'), ipv4('10.1.1.2'), ipv4('100.120.1.2')],
    'Wi-Fi': [ipv4('192.168.1.20')],
    'Ethernet 2': [{ ...ipv4('10.8.0.2'), netmask: '255.255.255.255' }],
    'Ethernet 3': [ipv4('198.18.0.1')],
    en0: [{ ...ipv4('192.168.2.20'), family: 4 }],
    wlo1: [ipv4('192.168.3.20')],
    utun3: [ipv4('10.3.1.1')],
    wg0: [ipv4('10.4.1.1')],
    'br-deadbeef': [ipv4('172.20.0.1')],
    vethabcd1234: [ipv4('172.21.0.1')],
    podman0: [ipv4('10.88.0.1')],
    waydroid0: [ipv4('192.168.240.1')],
    lxcbr0: [ipv4('10.0.3.1')],
    cni0: [ipv4('10.244.0.1')],
    lo: [{ ...ipv4('127.0.0.1'), internal: true }],
    invalid: ['0.0.0.0', '127.0.0.2', '169.254.3.4', '224.0.0.251', '255.255.255.255', 'bad'].map(ipv4),
    ipv6: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
  })
  assert.deepEqual(values.map(value => value.address), ['192.168.1.20', '192.168.2.20', '192.168.3.20', '10.1.1.2'])
  assert.equal(values[0].name, 'Wi-Fi')
})

test('VPN-only machines do not advertise an unusable pairing address; genuine carrier-shared LANs remain possible', t => {
  t.mock.method(os, 'networkInterfaces', () => ({ Wintun: [ipv4('10.8.0.2')], Tailscale: [ipv4('100.100.1.2')] }))
  assert.equal(getRemoteConnectionInfo().primary, null)
  assert.equal(getRemoteConnectionInfo().qrUrl, null)
  assert.deepEqual(lanInterfaces({ 'Wi-Fi': [ipv4('100.65.1.2')] }).map(i => i.address), ['100.65.1.2'])
})

test('an explicitly external Hyper-V bridge can provide a real LAN connection', () => {
  const values = lanInterfaces({
    'vEthernet (Default Switch)': [ipv4('172.28.1.1')],
    'vEthernet (External Switch)': [ipv4('192.168.10.2')],
  })
  assert.deepEqual(values.map(value => value.address), ['192.168.10.2'])
})

function socket() {
  const value = new EventEmitter()
  value.queries = []; value.responses = []; value.destroyed = 0
  value.query = packet => value.queries.push(packet)
  value.respond = packet => value.responses.push(packet)
  value.destroy = () => { value.destroyed++ }
  return value
}

test('mDNS uses explicit LAN multicast routes and sends only the local subnet address on each interface', () => {
  const sockets = new Map()
  const acquire = createMdnsPool({
    interfaces: () => lanInterfaces(adapters()),
    mdns: options => {
      assert.equal(options.bind, '0.0.0.0')
      const value = socket(); sockets.set(options.interface, value); return value
    },
  })
  const client = acquire()
  try {
    assert.deepEqual([...sockets.keys()], ['192.168.1.20', '10.0.0.9'])
    client.query({ questions: [{ name: '_lokal._tcp.local', type: 'PTR' }] })
    const answers = [{ name: 'host.local', type: 'A', data: '192.168.1.20' },
      { name: 'host.local', type: 'A', data: '10.0.0.9' },
      { name: 'host.local', type: 'A', data: '192.168.99.9' }, // Address removed during a network change.
      { name: 'service', type: 'TXT', data: [] }]
    client.respond({ answers })
    for (const [address, value] of sockets) {
      assert.equal(value.queries.length, 1)
      assert.deepEqual(value.responses[0].answers.filter(a => a.type === 'A').map(a => a.data), [address])
      assert.equal(value.responses[0].answers.length, 2)
    }
    assert.equal(answers.length, 4)
  } finally { client.destroy() }
})

test('Cast/link leases share sockets, follow LAN changes, and release their own listeners', () => {
  let addresses = ['192.168.1.20']
  const created = []
  const acquire = createMdnsPool({ interfaces: () => addresses.map(address => ({ address })), mdns: () => {
    const value = socket(); created.push(value); return value
  } })
  const cast = acquire(), link = acquire()
  let replies = 0
  cast.on('response', () => replies++)
  link.on('response', () => replies++)
  try {
    assert.equal(created.length, 1)
    created[0].emit('response', {})
    assert.equal(replies, 2)
    cast.destroy(); cast.destroy()
    assert.equal(created[0].destroyed, 0)
    created[0].emit('response', {})
    assert.equal(replies, 3)
    addresses = ['192.168.2.20']
    link.query({ questions: [] })
    assert.equal(created[0].destroyed, 1)
    assert.equal(created.length, 2)
    assert.equal(created[1].queries.length, 1)
    created[0].emit('response', {})
    assert.equal(replies, 3)
  } finally { cast.destroy(); link.destroy() }
  assert.equal(created[1].destroyed, 1)
})

test('no eligible LAN does not silently fall back to default/VPN multicast', () => {
  let created = false
  const acquire = createMdnsPool({ interfaces: () => [], mdns: () => { created = true; return socket() } })
  const client = acquire()
  try { client.query({ questions: [] }); client.respond({ answers: [] }); assert.equal(created, false) }
  finally { client.destroy() }
})

test('a socket failure is retried and transient interface inventory errors do not crash discovery', () => {
  const created = []
  let inventoryFailed = false
  const acquire = createMdnsPool({ interfaces: () => {
    if (inventoryFailed) throw new Error('Interface inventory unavailable')
    return [{ address: '192.168.1.20' }]
  }, mdns: () => { const value = socket(); created.push(value); return value } })
  const client = acquire()
  try {
    created[0].emit('error', new Error('Interface changed during bind'))
    assert.equal(created[0].destroyed, 1)
    client.query({ questions: [] })
    assert.equal(created.length, 2)
    inventoryFailed = true
    assert.doesNotThrow(() => client.query({ questions: [] }))
    assert.equal(created[1].queries.length, 2)
  } finally { client.destroy() }
})

test('link advertisements and goodbye records contain only eligible LAN addresses', () => {
  const mdns = socket()
  const stop = advertise({ id: 'desktop-id', port: 3421, name: 'Desktop', version: '14.3.1' }, {
    mdnsFactory: () => mdns, interfaces: () => lanInterfaces(adapters()),
  })
  try {
    assert.deepEqual(mdns.responses[0].answers.filter(a => a.type === 'A').map(a => a.data), ['192.168.1.20', '10.0.0.9'])
    mdns.emit('query', { questions: [{ name: '_lokal._tcp.local' }] })
    assert.equal(mdns.responses.length, 2)
  } finally { stop() }
  assert.ok(mdns.responses.at(-1).answers.every(a => a.ttl === 0))
  assert.equal(mdns.destroyed, 1)
})
