#!/usr/bin/env node

// Native
const path = require('path')

// Packages
const chalk = require('chalk')
const table = require('text-table')
const mri = require('mri')
const fs = require('fs-extra')
const ms = require('ms')
const printf = require('printf')
const plural = require('pluralize')
require('epipebomb')()
const supportsColor = require('supports-color')

// Utilities
const { handleError, error } = require('../util/error')
const NowCerts = require('../util/certs')
const exit = require('../../../util/exit')
const logo = require('../../../util/output/logo')

const help = () => {
  console.log(`
  ${chalk.bold(`${logo} now certs`)} [options] <command>

  ${chalk.yellow('NOTE:')} This command is intended for advanced use only.
  By default, Now manages your certificates automatically.

  ${chalk.dim('Commands:')}

    ls                    Show all available certificates
    create    [domain]    Create a certificate for a domain
    renew     [domain]    Renew the certificate of a existing domain
    replace   [domain]    Switch out a domain's certificate

  ${chalk.dim('Options:')}

    -h, --help                     Output usage information
    -A ${chalk.bold.underline('FILE')}, --local-config=${chalk.bold.underline(
    'FILE'
  )}   Path to the local ${'`now.json`'} file
    -Q ${chalk.bold.underline('DIR')}, --global-config=${chalk.bold.underline(
    'DIR'
  )}    Path to the global ${'`.now`'} directory
    -d, --debug                    Debug mode [off]
    -t ${chalk.bold.underline('TOKEN')}, --token=${chalk.bold.underline(
    'TOKEN'
  )}        Login token
    --crt ${chalk.bold.underline('FILE')}                     Certificate file
    --key ${chalk.bold.underline('FILE')}                     Certificate key file
    --ca ${chalk.bold.underline('FILE')}                      CA certificate chain file
    -T, --team                     Set a custom team scope

  ${chalk.dim('Examples:')}

  ${chalk.gray(
    '–'
  )} Replace an existing certificate with a custom one

      ${chalk.cyan(
        '$ now certs replace --crt domain.crt --key domain.key --ca ca_chain.crt domain.com'
      )}
`)
}

// Options
let argv
let debug
let apiUrl
let subcommand

const main = async ctx => {
  argv = mri(ctx.argv.slice(2), {
    string: ['crt', 'key', 'ca'],
    boolean: ['help', 'debug'],
    alias: {
      help: 'h',
      debug: 'd'
    }
  })

  argv._ = argv._.slice(1)

  apiUrl = ctx.apiUrl
  debug = argv.debug
  subcommand = argv._[0]

  if (argv.help || !subcommand) {
    help()
    await exit(0)
  }

  const {authConfig: { credentials }, config: { sh }} = ctx
  const {token} = credentials.find(item => item.provider === 'sh')

  try {
    await run({ token, sh })
  } catch (err) {
    handleError(err)
    exit(1)
  }
}

module.exports = async ctx => {
  try {
    await main(ctx)
  } catch (err) {
    handleError(err)
    process.exit(1)
  }
}

function formatExpirationDate(date) {
  const diff = date - Date.now()
  return diff < 0
    ? chalk.gray(ms(-diff) + ' ago')
    : chalk.gray('in ' + ms(diff))
}

async function run({ token, sh: { currentTeam, user } }) {
  const certs = new NowCerts({ apiUrl, token, debug, currentTeam })
  const args = argv._.slice(1)
  const start = Date.now()

  if (subcommand === 'ls' || subcommand === 'list') {
    if (args.length !== 0) {
      console.error(error(
        `Invalid number of arguments. Usage: ${chalk.cyan('`now certs ls`')}`
      ))
      return exit(1)
    }

    const list = await certs.ls()
    const elapsed = ms(new Date() - start)

    console.log(
      `> ${
        plural('certificate', list.length, true)
      } found ${chalk.gray(`[${elapsed}]`)} under ${chalk.bold(
        (currentTeam && currentTeam.slug) || user.username || user.email
      )}`
    )

    if (list.length > 0) {
      const cur = Date.now()
      list.sort((a, b) => {
        return a.cn.localeCompare(b.cn)
      })

      const maxCnLength =
        list.reduce((acc, i) => {
          return Math.max(acc, (i.cn && i.cn.length) || 0)
        }, 0) + 1

      console.log(
        chalk.dim(
          printf(
            `  %-${maxCnLength}s %-8s  %-10s  %-10s`,
            'cn',
            'created',
            'expiration',
            'auto-renew'
          )
        )
      )

      list.forEach(cert => {
        const cn = chalk.bold(cert.cn)
        const time = chalk.gray(ms(cur - new Date(cert.created)) + ' ago')
        const expiration = formatExpirationDate(new Date(cert.expiration))
        const autoRenew = cert.autoRenew ? 'yes' : 'no'
        let spec
        if (supportsColor) {
          spec = `  %-${maxCnLength + 9}s %-18s  %-20s  %-20s\n`
        } else {
          spec = `  %-${maxCnLength}s %-8s  %-10s  %-10s\n`
        }
        process.stdout.write(printf(spec, cn, time, expiration, autoRenew))
      })
    }
  } else if (subcommand === 'create') {
    if (args.length !== 1) {
      console.error(error(
        `Invalid number of arguments. Usage: ${chalk.cyan(
          '`now certs create <cn>`'
        )}`
      ))
      return exit(1)
    }
    const cn = args[0]
    let cert

    if (argv.crt || argv.key || argv.ca) {
      // Issue a custom certificate
      if (!argv.crt || !argv.key) {
        console.error(error(
          `Missing required arguments for a custom certificate entry. Usage: ${chalk.cyan(
            '`now certs create --crt DOMAIN.CRT --key DOMAIN.KEY [--ca CA.CRT] <id | cn>`'
          )}`
        ))
        return exit(1)
      }

      const crt = readX509File(argv.crt)
      const key = readX509File(argv.key)
      const ca = argv.ca ? readX509File(argv.ca) : ''

      cert = await certs.put(cn, crt, key, ca)
    } else {
      // Issue a standard certificate
      cert = await certs.create(cn)
    }
    if (!cert) {
      // Cert is undefined and "Cert is already issued" has been printed to stdout
      return exit(1)
    }
    const elapsed = ms(new Date() - start)
    console.log(
      `${chalk.cyan('> Success!')} Certificate entry ${chalk.bold(
        cn
      )} ${chalk.gray(`(${cert.uid})`)} created ${chalk.gray(`[${elapsed}]`)}`
    )
  } else if (subcommand === 'renew') {
    if (args.length !== 1) {
      console.error(error(
        `Invalid number of arguments. Usage: ${chalk.cyan(
          '`now certs renew <id | cn>`'
        )}`
      ))
      return exit(1)
    }

    const cert = await getCertIdCn(certs, args[0], currentTeam, user)
    if (!cert) {
      return exit(1)
    }
    const yes = await readConfirmation(
      cert,
      'The following certificate will be renewed\n'
    )

    if (!yes) {
      console.error(error('User abort'))
      return exit(0)
    }

    await certs.renew(cert.cn)
    const elapsed = ms(new Date() - start)
    console.log(
      `${chalk.cyan('> Success!')} Certificate ${chalk.bold(
        cert.cn
      )} ${chalk.gray(`(${cert.uid})`)} renewed ${chalk.gray(`[${elapsed}]`)}`
    )
  } else if (subcommand === 'replace') {
    if (!argv.crt || !argv.key) {
      console.error(error(
        `Invalid number of arguments. Usage: ${chalk.cyan(
          '`now certs replace --crt DOMAIN.CRT --key DOMAIN.KEY [--ca CA.CRT] <id | cn>`'
        )}`
      ))
      return exit(1)
    }

    const crt = readX509File(argv.crt)
    const key = readX509File(argv.key)
    const ca = argv.ca ? readX509File(argv.ca) : ''

    const cert = await getCertIdCn(certs, args[0], currentTeam, user)
    if (!cert) {
      return exit(1)
    }
    const yes = await readConfirmation(
      cert,
      'The following certificate will be replaced permanently\n'
    )
    if (!yes) {
      console.error(error('User abort'))
      return exit(0)
    }

    await certs.put(cert.cn, crt, key, ca)
    const elapsed = ms(new Date() - start)
    console.log(
      `${chalk.cyan('> Success!')} Certificate ${chalk.bold(
        cert.cn
      )} ${chalk.gray(`(${cert.uid})`)} replaced ${chalk.gray(`[${elapsed}]`)}`
    )
  } else if (subcommand === 'rm' || subcommand === 'remove') {
    if (args.length !== 1) {
      console.error(error(
        `Invalid number of arguments. Usage: ${chalk.cyan(
          '`now certs rm <id | cn>`'
        )}`
      ))
      return exit(1)
    }

    const cert = await getCertIdCn(certs, args[0], currentTeam, user)
    if (!cert) {
      return exit(1)
    }
    const yes = await readConfirmation(
      cert,
      'The following certificate will be removed permanently\n'
    )
    if (!yes) {
      console.error(error('User abort'))
      return exit(0)
    }

    await certs.delete(cert.cn)
    const elapsed = ms(new Date() - start)
    console.log(
      `${chalk.cyan('> Success!')} Certificate ${chalk.bold(
        cert.cn
      )} ${chalk.gray(`(${cert.uid})`)} removed ${chalk.gray(`[${elapsed}]`)}`
    )
  } else {
    console.error(error(
      'Please specify a valid subcommand: ls | create | renew | replace | rm'
    ))
    help()
    exit(1)
  }
  return certs.close()
}

process.on('uncaughtException', err => {
  handleError(err)
  exit(1)
})

function readConfirmation(cert, msg) {
  return new Promise(resolve => {
    const time = chalk.gray(ms(new Date() - new Date(cert.created)) + ' ago')
    const tbl = table([[cert.uid, chalk.bold(cert.cn), time]], {
      align: ['l', 'r', 'l'],
      hsep: ' '.repeat(6)
    })

    process.stdout.write(`> ${msg}`)
    process.stdout.write('  ' + tbl + '\n')

    process.stdout.write(
      `${chalk.bold.red('> Are you sure?')} ${chalk.gray('[y/N] ')}`
    )

    process.stdin
      .on('data', d => {
        process.stdin.pause()
        resolve(d.toString().trim().toLowerCase() === 'y')
      })
      .resume()
  })
}

function readX509File(file) {
  return fs.readFileSync(path.resolve(file), 'utf8')
}

async function getCertIdCn(certs, idOrCn, currentTeam, user) {
  const list = await certs.ls()
  const thecert = list.filter(cert => {
    return cert.uid === idOrCn || cert.cn === idOrCn
  })[0]

  if (!thecert) {
    console.error(error(
      `No certificate found by id or cn "${idOrCn}" under ${chalk.bold(
        (currentTeam && currentTeam.slug) || user.username || user.email
      )}`
    ))
    return null
  }

  return thecert
}
