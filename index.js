// Harmony Microservice

process.env.DEBUG = 'HarmonyHost,HostBase'

const debug        = require('debug')('HarmonyHost'),
      Config       = require('./config'),
      HostBase     = require('microservice-core/HostBase'),
      harmony      = require('harmonyhubjs-client'),
      parameterize = require('parameterize')

const mqttHost  = process.env.MQTT_HOST || 'mqtt://ha',
      topicRoot = process.env.TOPIC_ROOT || 'harmony'

/**
 * How fast to poll the Harmony Hub for state changes
 *
 * The faster we poll, the more CPU we use but the more real-time
 * the changes are sent to the clients.  The bigger this value,
 * the more lag there will be when one device changes state and
 * for that state change to appear on another device.
 *
 * Too fast and the hub may be overloaded and crash. Faster than
 * 100ms, and the hub returns 503 errors!
 *
 * @type {number}
 */
const POLL_TIME = 100

function getCommandsFromControlGroup(controlGroup) {
    const deviceCommands = {}

    controlGroup.some(function (group) {
        group.function.some(function (func) {
            slug                 = parameterize(func.label)
            deviceCommands[slug] = {name: func.name, slug: slug, label: func.label}
            Object.defineProperty(deviceCommands[slug], "action", {
                enumerable: false,
                writeable:  true,
                value:      func.action.replace(/\:/g, '::')
            });
        })
    })
    return deviceCommands
}

class HarmonyHost extends HostBase {
    constructor(config) {
        super(mqttHost, topicRoot + '/' + config.device, true)
        debug('construct', config)
        this.device = config.device
        this.ip     = config.ip
        this.mac    = config.mac
        this.client.on('connect', () => {
            this.client.subscribe(this.topic + '/set/#')
        })
        this.client.on('message', async (topic, message) => {
            message = message.toString()
            debug(this.topic, 'topic', topic, 'message', message.substr(0, 32))
            if (topic.endsWith('command')) {
                Promise.resolve(await this.command(message))
            }
            else if (topic.endsWith('activity')) {
                Promise.resolve(await this.startActivity(message))
            }
            const parts = topic.split('/')
            if (parts[3] === 'device') {
                this.deviceCommand(parts[4], message)

            }
            else {
                debug('invalid topic', topic)
            }
        })
    }

    async connect() {
        return new Promise(async (resolve, reject) => {
            debug(this.device, 'connecting')
            try {
                this.harmonyClient = await harmony(this.ip)
                process.on('exit', () => {
                    debug(this.device, 'exit', 'harmonyClient.end()')
                    this.harmonyClient.end()
                })
                process.on('SIGINT', () => {
                    debug(this.device, 'SIGINT', 'harmonyClient.end()')
                    this.harmonyClient.end()
                    process.exit()
                })
                await this.refresh()
                this.state = {
                    availableCommands: this.availableCommands,
                    activities:        this.activities,
                    devices:           this.devices
                }
                this.poll()
                resolve()
            }
            catch (e) {
                debug(this.harmonyClient, 'exception', e)
                reject(e)
            }
        })
    }

    async refresh() {
        return new Promise(async (resolve, reject) => {
            try {
                this.availableCommands = await this.harmonyClient.getAvailableCommands()
                this.devices           = await this.getDevices()
                this.activities        = await this.getActivities()
                // TODO: activities fixit?
                resolve()
            }
            catch (e) {
                reject(e)
            }
        })
    }

    getCommands() {
        const currentActivity = this.state.activities[this.state.currentActivity],
              controlGroup    = currentActivity.controlGroup,
              commands        = {}

        controlGroup.forEach((group) => {
            group.function.forEach((func) => {
                commands[func.name] = func
            })
        })
        return commands
    }

    /**
     * Start an activity.
     *
     * @param activity - activty ID of actifity to start.  PowerOff ('-1') will
     * turn everything off.
     *
     * @returns {Promise.<Promise|*|Q.Promise>}
     */
    async startActivity(activity) {
        return new Promise(async (resolve, reject) => {
            try {
                this.state = {startingActivity: activity}
                this.publish()
                const ret  = await this.harmonyClient.startActivity(activity)
                this.state = {startingActivity: null}
                this.publish()
                resolve(ret)
            }
            catch (e) {
                debug('exception ', e)
                reject(e)
            }
        })
    }

    async poll() {
        debug(this.device, 'poll')
        while (1) {
            const startingActivity = this.state ? this.state.startingActivity : null,
                  currentActivity  = startingActivity || await this.getCurrentActivity(),
                  newActivity = this.state.currentActivity !== currentActivity

            try {
                this.state = {
                    isOff:             await this.harmonyClient.isOff(),
                    currentActivity:   currentActivity,
                    // availableCommands: this.availableCommands,
                    // activities:        this.activities,
                    // devices:           this.devices
                }
                if (newActivity) {
                    this.state = {
                        commands: this.getCommands()    // get commands for current activity
                    }
                }
                // if (!this.once) {
                //     debug(this.device, this.state)
                //     this.once = true
                // }
            }
            catch (e) {
                debug(this.device, 'poll exception', e)
            }
            await this.wait(POLL_TIME)
        }
    }

    /**
     * @private
     * @returns {Promise.<Promise|*|Q.Promise>}
     */
    async getCurrentActivity() {
        return this.harmonyClient.getCurrentActivity()
    }

    /**
     * @private
     * @returns {Promise.<{}>}
     */
    async getActivities() {
        const activities = {}

        try {
            const records = await this.harmonyClient.getActivities()
            // debug(this.device, 'getActivities', records)
            records.forEach((activity) => {
                activities[activity.id] = activity
            })
            return activities
        }
        catch (e) {
            debug(this.device, 'updateActivities exception', e)
            throw e
        }
    }

    /**
     * @private
     * @returns {Promise.<{}>}
     */
    async getDevices() {
        const devices = {},
              slugs   = {}
        try {
            const commands = await this.harmonyClient.getAvailableCommands()
            // debug(this.device, 'getAvailableCommands', commands)
            commands.device.forEach((device) => {
                device.slug        = parameterize(device.label)
                device.commands    = getCommandsFromControlGroup(device.controlGroup)
                devices[device.id] = device
                slugs[device.slug] = device
            })
            this.deviceSlugs = slugs
            return devices
        }
        catch (e) {
            debug(this.device, 'updateDevices exception', e)
            throw e
        }
    }

    /**
     * Execute a command, simulating a button press/release
     * @param command
     * @returns {Promise.<*>}
     */
    async command(command) {
        debug(this.device, 'command', command)
        const commands = this.state.commands,
              control  = commands ? commands[command] : null

        if (!control) {
            debug(this.device, 'command', command, control)
            return Promise.resolve(new Error('Invalid command ' + command))
        }

        return new Promise(async (resolve, reject) => {
            const action = control.action.replace(/\:/g, '::')
            // debug(this.device, 'command', command, 'control', control, 'action', action)
            try {
                await this.harmonyClient.send('holdAction', 'action=' + action + ':status=press')
                await this.harmonyClient.send('holdAction', 'action=' + action + ':status=release')
                resolve()
            }
            catch (e) {
                reject(e)
            }
        })
    }

    findAction(device, slug) {
        if (!device) {
            return null
        }
        const slugs = device.commands

        if (slugs[slug]) {
            return slugs[slug].action
        }

        const keys = Object.keys(slugs)
        let action = null
        keys.some((key) => {
            if (slugs[key].name === slug) {
                action = slugs[key].action
                return true
            }
        })
        return action
    }

    async deviceCommand(deviceSlug, command) {
        const device = this.deviceSlugs[deviceSlug],
              action = this.findAction(device, command)

        if (!action) {
            Promise.reject(new Error('No such action ' + command))
        }
        if (!device) {
            Promise.reject(new Error('No such device ' + deviceSlug))
        }

        return new Promise(async (resolve, reject) => {
            // debug(this.device, 'deviceCommand', deviceSlug, command, action)
            try {
                await this.harmonyClient.send('holdAction', 'action=' + action + ':status=press')
                await this.harmonyClient.send('holdAction', 'action=' + action + ':status=release')
                resolve()
            }
            catch (e) {
                reject(e)
            }
        })
    }
}

const hubs = {}

async function main() {
    Config.hubs.forEach((hub) => {
        hubs[hub.device] = new HarmonyHost(hub)
    })

    Object.keys(hubs).forEach(async (hub) => {
        try {
            await hubs[hub].connect()
        }
        catch (e) {
            console.dir(hub)
            console.dir(e)
        }
    })
}

main()