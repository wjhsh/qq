"""Explicit Pi channel selection. Upstream account tokens stay in the gateway."""
PI_ENGINES = ('pi', 'pi-workbuddy')
WORKBUDDY_MODEL = 'deepseek-v4.1-flash'


def profile(engine, google_model):
    if engine == 'pi-workbuddy':
        return {
            'provider': 'workbuddy', 'model': WORKBUDDY_MODEL,
            'baseUrl': 'http://127.0.0.1:8788/v1',
            'apiKey': '${WORKBUDDY_API_KEY}',
            'envFile': '/etc/qq-harness/workbuddy.env',
            'name': 'WorkBuddy · DeepSeek V4.1 Flash',
        }
    if engine == 'pi':
        return {
            'provider': 'cloud', 'model': google_model,
            'baseUrl': 'http://127.0.0.1:8317/v1',
            'apiKey': '${HARNESS_API_KEY}',
            'envFile': '/etc/qq-harness/model.env',
            'name': 'Cloud Gemini',
        }
    raise ValueError('Unknown Pi channel')


def models(engine, google_model):
    selected = profile(engine, google_model)
    model = {
        'id': selected['model'], 'name': selected['name'], 'reasoning': False,
        'input': ['text'], 'contextWindow': 131072, 'maxTokens': 8192,
        'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
    }
    if engine == 'pi-workbuddy':
        model['samplingParams'] = {'thinking': {'type': 'disabled'}, 'reasoning_effort': 'none'}
    return {'providers': {selected['provider']: {
        'baseUrl': selected['baseUrl'], 'api': 'openai-completions',
        'apiKey': selected['apiKey'], 'models': [model],
    }}}
