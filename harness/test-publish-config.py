import io,json,unittest,urllib.error
from unittest.mock import patch,MagicMock
import cloud_controls

class PublicationConfigurationTest(unittest.TestCase):
 def account(self):
  item=MagicMock();item.read_text.return_value=json.dumps({'refresh_token':'test-refresh','access_token':'expired-test','project_id':'test-project'});return item
 def test_missing_oauth_environment_stops_refresh_without_network_submission(self):
  control=cloud_controls.Controls();control.proxy=MagicMock()
  with patch.object(cloud_controls.Path,'glob',return_value=[self.account()]),patch.object(cloud_controls,'PUBLIC_CLIENT_ID',''),patch.object(cloud_controls,'PUBLIC_CLIENT_SECRET',''),patch.object(control,'json',side_effect=urllib.error.HTTPError('https://example.invalid',401,'test',None,None)):
   result=control.google(1)
  self.assertFalse(result['available']);self.assertIn('OAuth',result['error']);control.proxy.open.assert_not_called()
 def test_configured_oauth_refresh_uses_only_provided_deployment_values(self):
  control=cloud_controls.Controls();control.proxy=MagicMock();control.proxy.open.return_value.__enter__.return_value=io.BytesIO(json.dumps({'access_token':'fresh-test','expires_in':3600}).encode())
  with patch.object(cloud_controls.Path,'glob',return_value=[self.account()]),patch.object(cloud_controls,'PUBLIC_CLIENT_ID','configured-test-id'),patch.object(cloud_controls,'PUBLIC_CLIENT_SECRET','configured-test-secret'),patch.object(control,'json',side_effect=[urllib.error.HTTPError('https://example.invalid',401,'test',None,None),{'models':{'gemini-3.8-flash-tiered':{'quotaInfo':{'remainingFraction':0.5}}}}]):
   result=control.google(1)
  self.assertTrue(result['available']);request=control.proxy.open.call_args.args[0];self.assertIn(b'client_id=configured-test-id',request.data);self.assertIn(b'client_secret=configured-test-secret',request.data)

if __name__=='__main__':unittest.main()
