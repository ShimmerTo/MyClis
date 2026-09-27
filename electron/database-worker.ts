import { runDriver, type DriverJob } from '../packages/database/src/drivers'

process.once('message', (input: DriverJob) => {
  void runDriver(input).then(result => {
    process.send?.({ ok: true, result }, () => process.exit(0))
  }).catch(() => {
    process.send?.({ ok: false }, () => process.exit(1))
  })
})
process.once('disconnect', () => process.exit(0))
