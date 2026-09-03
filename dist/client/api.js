export function createApi(api) {
    const call = api.rpc.bind(api);
    return {
        list: () => call('GET', '/v1/jobs').then(body => body.jobs),
        targets: () => call('GET', '/v1/targets').then(body => body.groups),
        models: () => call('GET', '/v1/models').then(body => body.models),
        create: input => call('POST', '/v1/jobs', input).then(body => body.job),
        patch: (id, body) => call('PATCH', `/v1/jobs/${encodeURIComponent(id)}`, body).then(body => body.job),
        remove: id => call('DELETE', `/v1/jobs/${encodeURIComponent(id)}`),
        action: (id, action) => action === 'run-now'
            ? call('POST', `/v1/jobs/${encodeURIComponent(id)}/actions/run-now`)
            : call('POST', `/v1/jobs/${encodeURIComponent(id)}/actions/${action}`).then(body => body.job),
        profile: () => call('GET', '/v1/profile').then(body => body.profile),
        setProfile: profile => call('PUT', '/v1/profile', profile).then(body => body.profile),
        dispatch: () => call('GET', '/v1/dispatch'),
        setDispatch: policy => call('PUT', '/v1/dispatch', policy).then(body => body.policy),
    };
}
//# sourceMappingURL=api.js.map