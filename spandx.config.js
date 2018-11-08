/*global module, process, require, __dirname*/
const tryRequire = require('try-require');
const lodash = require('lodash');
const base64 = require('base-64');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const fs = require('fs');
const localhost = (process.env.PLATFORM === 'linux') ? 'localhost' : 'host.docker.internal';
const protocol = (process.env.SSL === 'true') ? 'https' : 'http';
const port = process.env.PORT || 8002;

const PORTAL_BACKEND_MARKER = 'PORTAL_BACKEND_MARKER';

const keycloakPubkeys = {
    prod:  fs.readFileSync(__dirname + '/certs/keycloak.prod.cert',  'utf8'),
    stage: fs.readFileSync(__dirname + '/certs/keycloak.stage.cert', 'utf8'),
    qa:    fs.readFileSync(__dirname + '/certs/keycloak.qa.cert',    'utf8')
};

const buildUser = input => {

    const user = {
        identity: {
            id: input.user_id,
            org_id: input.account_id,
            account_number: input.account_number,
            username: input.username,
            email: input.email,
            first_name: input.firstName,
            last_name: input.lastName,
            address_string: `"${input.firstName} ${input.lastName}" ${input.email}`,
            is_active: true,
            locale: input.lang,
            is_org_admin: lodash.includes(input.realm_access.roles, 'admin:org:all'),
            is_internal: lodash.includes(input.realm_access.roles,  'redhat:employees')
        }
    };

    return user;
};

const envMap = {
    ci: {
        keycloakPubkey: keycloakPubkeys.qa,
        target: 'https://access.ci.itop.redhat.com',
        str: 'ci'
    },
    qa: {
        keycloakPubkey: keycloakPubkeys.qa,
        target: 'https://access.qa.itop.redhat.com',
        str: 'qa'
    },
    stage: {
        keycloakPubkey: keycloakPubkeys.stage,
        target: 'https://access.stage.itop.redhat.com',
        str: 'stage'
    },
    prod: {
        keycloakPubkey: keycloakPubkeys.prod,
        target: 'https://access.redhat.com',
        str: 'prod'
    }
};

const authPlugin = (req, res, target) => {
    let env = envMap.prod;

    if (target === PORTAL_BACKEND_MARKER) {
        switch (req.headers['x-spandx-origin']) {
            case 'ci.foo.redhat.com':    env = envMap.ci;    break;
            case 'qa.foo.redhat.com':    env = envMap.qa;    break;
            case 'stage.foo.redhat.com': env = envMap.stage; break;
            case 'prod.foo.redhat.com':  env = envMap.prod;  break;
            default: env = false;
        }

        target = env.target;
        console.log(`    --> mangled ${PORTAL_BACKEND_MARKER} to ${target}`);
    }

    const noop = { then: (cb) => { cb(target); } };
    if (!req || !req.headers || !req.headers.cookie) { return noop; } // no cookies short circut

    const cookies = cookie.parse(req.headers.cookie);
    if (!cookies.rh_jwt) { return noop; } // no rh_jwt short circut

    return new Promise (function (resolve, reject) {
        jwt.verify(cookies.rh_jwt, env.keycloakPubkey, {}, function jwtVerifyPromise(err, decoded) {
            if (err) { resolve(target); return; } // silently miss on error
            const user = buildUser(decoded);
            req.headers['x-rh-identity'] = base64.encode(user.identity);
            resolve(target);
        });
    });
};

const defaults = {
    routerPlugin: authPlugin,
    bs: {
        https: {
            key:  __dirname + '/ssl/key.pem',
            cert: __dirname + '/ssl/cert.pem'
        }
    },
    esi: {
        allowedHosts: [
            /^https:\/\/access.*.redhat.com$/
        ]
    },
    host: {
        'ci.foo.redhat.com':    'ci.foo.redhat.com',
        'qa.foo.redhat.com':    'qa.foo.redhat.com',
        'stage.foo.redhat.com': 'stage.foo.redhat.com',
        'prod.foo.redhat.com':  'prod.foo.redhat.com'
    },
    port: process.env.SPANDX_PORT || 1337,
    open: false,
    startPath: '/',
    verbose: true,
    routes: {}
};

if (process.env.LOCAL_API === 'true') {
    defaults.routes['/r/insights'] = { host: `https://${localhost}:9001` };
}

if (process.env.LOCAL_CHROME === 'true') {
    defaults.routes['/insights/static/chrome']     = '/chrome/';
    defaults.routes['/insightsbeta/static/chrome'] = '/chrome/';
} else {
    defaults.routes['/insights/static/chrome']     = { host: PORTAL_BACKEND_MARKER };
    defaults.routes['/insightsbeta/static/chrome'] = { host: PORTAL_BACKEND_MARKER };
}

defaults.routes['/insights'] = { host: `${protocol}://${localhost}:${port}` };
defaults.routes['/'] = { host: PORTAL_BACKEND_MARKER };

const custom = tryRequire('/config/spandx.config') || {};
const ret = lodash.defaultsDeep(custom, defaults);

console.log('\n');
console.log('### USING SPANDX CONFIG ###');
console.log(ret);
console.log('###########################');
console.log('For more info see: https://github.com/redhataccess/spandx');
console.log(`Insights Proxy version: ${require('./package.json').version}`);
console.log('\n');

process.on('SIGINT', function() {
    process.exit();
});

module.exports = ret;
