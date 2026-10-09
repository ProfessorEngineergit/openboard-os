// Home Assistant integration via MQTT discovery. OpenBoard appears as one device
// with switch/select/text/button/sensor entities; dock buttons of type
// "action.mqtt" become device triggers usable in HA automations.
import { EventEmitter } from 'node:events';
import mqtt from 'mqtt';

const slug = value => String(value).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';

export function widgetTriggers(config) {
  const triggers = new Map();
  for (const tile of config.dock.tiles) for (const item of tile.items) {
    if (item.type !== 'action.mqtt') continue;
    const name = slug(item.options?.name || item.id);
    triggers.set(name, { name, label: item.options?.label || name, payload: String(item.options?.payload ?? 'press') });
  }
  return [...triggers.values()];
}

export function valueTopics(config) {
  const topics = new Set();
  for (const tile of config.dock.tiles) for (const item of tile.items) if (item.type === 'mqtt.value' && item.options?.topic) topics.add(item.options.topic);
  return [...topics];
}

// Builds every discovery message: [topic, payload] pairs.
export function discoveryMessages(config, { version, apps }) {
  const { discoveryPrefix: prefix, nodeId: node } = config.mqtt;
  const base = `openboard/${node}`;
  const device = { identifiers: [`openboard_${node}`], name: 'OpenBoard', manufacturer: 'OpenBoard', model: 'Whiteboard-OS', sw_version: version };
  const common = { availability_topic: `${base}/status`, device };
  const entity = (component, object, body) => [`${prefix}/${component}/${node}/${object}/config`, JSON.stringify({ unique_id: `openboard_${node}_${object}`, object_id: `openboard_${object}`, ...common, ...body })];
  const sensor = (object, name, template, extra = {}) => entity('sensor', object, { name, state_topic: `${base}/sensors`, value_template: template, ...extra });
  return [
    entity('switch', 'screen', { name: 'Bildschirm', icon: 'mdi:monitor', state_topic: `${base}/screen/state`, command_topic: `${base}/screen/set` }),
    entity('select', 'app', { name: 'App', icon: 'mdi:apps', state_topic: `${base}/app/state`, command_topic: `${base}/app/set`, options: apps.map(app => app.name) }),
    entity('select', 'performance', { name: 'Leistungsmodus', icon: 'mdi:speedometer', state_topic: `${base}/performance/state`, command_topic: `${base}/performance/set`, options: ['eco', 'balanced', 'max'] }),
    entity('select', 'orientation', { name: 'Ausrichtung', icon: 'mdi:screen-rotation', state_topic: `${base}/orientation/state`, command_topic: `${base}/orientation/set`, options: ['landscape', 'portrait', 'landscape-flipped', 'portrait-flipped'] }),
    entity('select', 'theme', { name: 'Design', icon: 'mdi:theme-light-dark', state_topic: `${base}/theme/state`, command_topic: `${base}/theme/set`, options: ['dark', 'light', 'auto'] }),
    entity('text', 'say', { name: 'Sagen', icon: 'mdi:account-voice', command_topic: `${base}/say/set`, state_topic: `${base}/say/state`, max: 255 }),
    entity('button', 'reload', { name: 'App neu laden', icon: 'mdi:reload', command_topic: `${base}/button/reload` }),
    entity('button', 'restart_browser', { name: 'Browser neu starten', icon: 'mdi:restart', command_topic: `${base}/button/restart_browser` }),
    sensor('cpu', 'CPU', '{{ value_json.cpu }}', { unit_of_measurement: '%', state_class: 'measurement', icon: 'mdi:cpu-64-bit' }),
    sensor('gpu', 'GPU', '{{ value_json.gpu }}', { unit_of_measurement: '%', state_class: 'measurement', icon: 'mdi:expansion-card' }),
    sensor('ram', 'RAM', '{{ value_json.ram }}', { unit_of_measurement: '%', state_class: 'measurement', icon: 'mdi:memory' }),
    sensor('temperature', 'Temperatur', '{{ value_json.temp }}', { unit_of_measurement: '°C', device_class: 'temperature', state_class: 'measurement' }),
    sensor('active_app', 'Aktive App', '{{ value_json.app }}', { icon: 'mdi:application' }),
    sensor('pressure', 'Lastlage', '{{ value_json.pressure }}', { icon: 'mdi:gauge' }),
    sensor('last_touch', 'Letzte Berührung', '{{ value_json.last_touch }}', { device_class: 'timestamp' }),
    sensor('version', 'Version', '{{ value_json.version }}', { icon: 'mdi:source-commit', entity_category: 'diagnostic' }),
    entity('binary_sensor', 'astra', { name: 'ASTRA verbunden', device_class: 'connectivity', state_topic: `${base}/astra/state` }),
    entity('binary_sensor', 'update', { name: 'Update verfügbar', device_class: 'update', state_topic: `${base}/update/state` }),
    ...widgetTriggers(config).map(trigger => [`${prefix}/device_automation/${node}/${trigger.name}/config`, JSON.stringify({
      automation_type: 'trigger', topic: `${base}/trigger/${trigger.name}`, type: 'button_short_press', subtype: trigger.label, payload: trigger.payload, device,
    })]),
  ];
}

export class MqttBridge extends EventEmitter {
  // handlers: { screen(on), app(name), performance(mode), theme(value), say(text), reload(), restartBrowser() }
  constructor({ config, handlers, log }) {
    super();
    Object.assign(this, { config, handlers, log });
    this.client = null; this.connected = false; this.values = {}; this.published = new Set(); this.subscribedValues = new Set(); this.lastSensors = 0;
  }

  get settings() { return this.config().mqtt; }
  get base() { return `openboard/${this.settings.nodeId}`; }
  status() { return { configured: !!this.settings.url, connected: this.connected }; }

  connect(context) {
    this.close();
    if (!this.settings.url) return;
    this.context = context;
    const client = mqtt.connect(this.settings.url, {
      username: this.settings.username || undefined, password: this.settings.password || undefined,
      clientId: `openboard_${this.settings.nodeId}_${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 5000, connectTimeout: 10000,
      will: { topic: `${this.base}/status`, payload: 'offline', retain: true, qos: 1 },
    });
    this.client = client;
    client.on('connect', () => {
      this.connected = true; this.emit('status', this.status());
      client.publish(`${this.base}/status`, 'online', { retain: true, qos: 1 });
      client.subscribe([`${this.base}/+/set`, `${this.base}/button/+`]);
      this.subscribedValues.clear();
      this.publishDiscovery(this.context());
      this.syncValueTopics();
      this.publishState(this.context(), true);
    });
    client.on('close', () => { if (this.connected) { this.connected = false; this.emit('status', this.status()); } });
    client.on('error', error => this.log(`MQTT: ${error.message}`));
    client.on('message', (topic, payload) => { void this.onMessage(topic, payload.toString()).catch(error => this.log(`MQTT-Befehl: ${error.message}`)); });
  }

  close() {
    if (!this.client) return;
    try { this.client.publish(`${this.base}/status`, 'offline', { retain: true }); } catch { /* closing */ }
    this.client.end(true); this.client = null; this.connected = false;
  }

  async onMessage(topic, text) {
    if (this.subscribedValues.has(topic)) { this.values[topic] = text; this.emit('values', this.values); return; }
    const base = this.base, h = this.handlers;
    if (topic === `${base}/screen/set`) await h.screen(text.toUpperCase() === 'ON');
    else if (topic === `${base}/app/set`) await h.app(text);
    else if (topic === `${base}/performance/set`) await h.performance(text);
    else if (topic === `${base}/theme/set`) await h.theme(text);
    else if (topic === `${base}/orientation/set`) await h.orientation(text);
    else if (topic === `${base}/say/set`) { this.client?.publish(`${base}/say/state`, text.slice(0, 255), { retain: true }); await h.say(text); }
    else if (topic === `${base}/button/reload`) await h.reload();
    else if (topic === `${base}/button/restart_browser`) await h.restartBrowser();
  }

  publishDiscovery(context) {
    if (!this.connected) return;
    const messages = discoveryMessages(this.config(), context);
    const topics = new Set(messages.map(([topic]) => topic));
    // Retract triggers that were removed from the dock.
    for (const topic of this.published) if (!topics.has(topic)) this.client.publish(topic, '', { retain: true });
    for (const [topic, payload] of messages) this.client.publish(topic, payload, { retain: true, qos: 1 });
    this.published = topics;
  }

  syncValueTopics() {
    if (!this.connected) return;
    const wanted = new Set(valueTopics(this.config()));
    for (const topic of this.subscribedValues) if (!wanted.has(topic)) { this.client.unsubscribe(topic); delete this.values[topic]; }
    for (const topic of wanted) if (!this.subscribedValues.has(topic)) this.client.subscribe(topic);
    this.subscribedValues = wanted;
  }

  // context: { asleep, appName, performance, theme, metrics, pressure, lastTouch, version, astra, updateAvailable }
  publishState(context, force = false) {
    if (!this.connected) return;
    const base = this.base, publish = (topic, value) => this.client.publish(`${base}/${topic}`, String(value), { retain: true });
    const signature = JSON.stringify([context.asleep, context.appName, context.performance, context.theme, context.orientation, context.astra, context.updateAvailable]);
    if (force || signature !== this.lastSignature) {
      this.lastSignature = signature;
      publish('screen/state', context.asleep ? 'OFF' : 'ON');
      publish('app/state', context.appName || '');
      publish('performance/state', context.performance);
      publish('theme/state', context.theme);
      publish('orientation/state', context.orientation);
      publish('astra/state', context.astra ? 'ON' : 'OFF');
      publish('update/state', context.updateAvailable ? 'ON' : 'OFF');
    }
    if (force || Date.now() - this.lastSensors > 10000) {
      this.lastSensors = Date.now();
      const m = context.metrics, round = value => Number.isFinite(value) ? Math.round(value) : null;
      publish('sensors', JSON.stringify({ cpu: round(m.cpu?.pct), gpu: round(m.gpu?.pct), ram: round(m.ram?.pct), temp: round(m.temp?.c),
        app: context.appName, pressure: context.pressure, last_touch: context.lastTouch ? new Date(context.lastTouch).toISOString() : null, version: context.version }));
    }
  }

  trigger(name, payload) {
    if (!this.connected) throw new Error('MQTT ist nicht verbunden');
    this.client.publish(`${this.base}/trigger/${slug(name)}`, String(payload ?? 'press'));
  }

  async test() {
    if (!this.settings.url) return { ok: false, detail: 'Keine Broker-URL' };
    return new Promise(resolve => {
      const client = mqtt.connect(this.settings.url, { username: this.settings.username || undefined, password: this.settings.password || undefined, reconnectPeriod: 0, connectTimeout: 8000 });
      const done = result => { client.end(true); resolve(result); };
      client.once('connect', () => done({ ok: true, detail: 'Broker erreichbar, Anmeldung erfolgreich' }));
      client.once('error', error => done({ ok: false, detail: error.message }));
      setTimeout(() => done({ ok: false, detail: 'Zeitüberschreitung' }), 9000);
    });
  }
}
