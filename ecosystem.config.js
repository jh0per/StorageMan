module.exports = {
  apps: [{
    name: 'myapp',
    script: 'npm',
    args: 'run start:prod',   // для dev: 'run start:dev', але watch у PM2 вимкни
    cwd: '/srv/myapp',
    exec_mode: 'fork',
    instances: 1,
    watch: false,
    env: { NODE_ENV: 'production' }
  }]
}
