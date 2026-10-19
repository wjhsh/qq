import http.client,importlib.util,io,json,threading,unittest
from unittest.mock import patch
from pathlib import Path
spec=importlib.util.spec_from_file_location('mobile_console',Path(__file__).with_name('mobile-console.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.settings={'dns_name':'huawei-hajimi.example.ts.net','operator_login':'owner@example.com','server_ips':['100.70.0.1','fd7a:115c:a1e0::1']}
        self.headers={'Host':self.settings['dns_name'],'Tailscale-User-Login':'owner@example.com','X-Forwarded-For':'100.70.0.2'}
    def check(self):return module.check_identity(self.headers,self.settings)
    def test_authorized_owner_phone(self):self.assertTrue(self.check())
    def test_other_tailnet_user_denied(self):self.headers['Tailscale-User-Login']='other@example.com';self.assertFalse(self.check())
    def test_missing_identity_denied(self):self.headers.pop('Tailscale-User-Login');self.assertFalse(self.check())
    def test_server_cannot_authenticate_itself(self):self.headers['X-Forwarded-For']='100.70.0.1';self.assertFalse(self.check())
    def test_forged_forwarding_does_not_hide_server_origin(self):self.headers['X-Forwarded-For']='100.70.0.2, 100.70.0.1';self.assertFalse(self.check())
    def test_loopback_or_public_origin_denied(self):
        for peer in ['127.0.0.1','203.0.113.10','invalid','']:
            self.headers['X-Forwarded-For']=peer;self.assertFalse(self.check())
    def test_other_host_denied(self):self.headers['Host']='attacker.example';self.assertFalse(self.check())
    def test_cross_origin_mutation_denied(self):self.headers['Origin']='https://attacker.example';self.assertFalse(self.check())
    def test_cross_origin_referer_denied(self):self.headers['Referer']='https://attacker.example/settings';self.assertFalse(self.check())
    def test_same_origin_allowed(self):self.headers.update(Origin='https://'+self.settings['dns_name'],Referer='https://'+self.settings['dns_name']+'/');self.assertTrue(self.check())
    def test_phone_ipv6_allowed(self):self.headers['X-Forwarded-For']='fd7a:115c:a1e0::2';self.assertTrue(self.check())
    def test_unrelated_private_network_denied(self):self.headers['X-Forwarded-For']='172.31.14.93';self.assertFalse(self.check())
class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.settings={'dns_name':'huawei-hajimi.example.ts.net','operator_login':'owner@example.com','server_ips':['100.70.0.1']}
        self.headers={'Host':self.settings['dns_name'],'Tailscale-User-Login':'owner@example.com','X-Forwarded-For':'100.70.0.2'}
        self.requests=[];self.payload=b'{"connected":true}';self.type='application/json'
        outer=self
        class Backend:
            def request(self,*args,**kwargs):outer.requests.append((args,kwargs))
            def getresponse(self):
                class Response(io.BytesIO):
                    status=200
                    def getheaders(self):return [('Content-Type',outer.type),('Content-Length',str(len(outer.payload)))]
                return Response(outer.payload)
            def close(self):pass
        self.patcher=patch.object(module,'open_backend',side_effect=Backend);self.patcher.start()
        self.server=module.MobileServer(('127.0.0.1',0),self.settings,'server-only-secret')
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.patcher.stop()
    def call(self,path='/api/status',method='GET',body=None):
        connection=http.client.HTTPConnection(*self.server.server_address,timeout=3)
        connection.request(method,path,body=body,headers=self.headers)
        response=connection.getresponse();value=(response.status,dict(response.getheaders()),response.read());connection.close();return value
    def test_private_api_injects_token_without_exposing_it(self):
        status,headers,body=self.call();self.assertEqual(status,200);self.assertEqual(json.loads(body),{'connected':True})
        sent=self.requests[0][1]['headers'];self.assertEqual(sent['x-console-token'],'server-only-secret');self.assertEqual(sent['Host'],'127.0.0.1:3210')
        self.assertNotIn('server-only-secret',str(headers)+body.decode())
    def test_client_cannot_override_the_backend_token(self):
        self.headers['x-console-token']='attacker-value';self.call();self.assertEqual(self.requests[0][1]['headers']['x-console-token'],'server-only-secret')
    def test_origin_is_checked_before_loopback_rewrite(self):
        self.headers['Origin']='https://evil.example';self.assertEqual(self.call()[0],403);self.assertEqual(self.requests,[])
    def test_valid_origin_is_rewritten_only_for_the_local_backend(self):
        self.headers['Origin']='https://'+self.settings['dns_name'];self.call();self.assertEqual(self.requests[0][1]['headers']['Origin'],'http://127.0.0.1:3210')
    def test_anonymous_static_pages_are_denied(self):
        self.headers.pop('Tailscale-User-Login');self.assertEqual(self.call('/')[0],403);self.assertEqual(self.requests,[])
    def test_sse_bytes_are_forwarded_without_buffering_or_token_injection(self):
        self.payload=b'event: hello\ndata: {}\n\n: ping\n\n';self.type='text/event-stream'
        status,headers,body=self.call('/api/events');self.assertEqual(status,200);self.assertEqual(body,self.payload);self.assertEqual(headers['Content-Type'],self.type)
    def test_light_workbench_is_one_document_without_external_dependencies(self):
        status,headers,body=self.call('/');self.assertEqual(status,200);self.assertIn('Agent'.encode(),body);self.assertNotIn('server-only-secret',body.decode());self.assertEqual(self.requests,[])
    def test_agent_token_is_injected_only_for_allowed_routes(self):
        self.server.harness_token='private-agent-key'
        with patch.object(module,'open_harness',side_effect=module.open_backend):
            self.call('/agent-api/jobs',method='POST',body='{"prompt":"test"}')
        sent=self.requests[-1][1]['headers'];self.assertEqual(sent['Authorization'],'Bearer private-agent-key');self.assertNotIn('x-console-token',sent)
        self.assertEqual(self.call('/agent-api/private/root')[0],404)
        self.assertEqual(self.call('/agent-api/jobs/../../status')[0],404)
    def test_qq_settings_keep_original_api_and_root_document(self):
        self.call('/qq');self.assertEqual(self.requests[-1][0][1],'/')
if __name__=='__main__':unittest.main()
