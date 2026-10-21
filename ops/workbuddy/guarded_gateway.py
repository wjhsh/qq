"""Private WorkBuddy API profile: no panel, desktop scanning or background tasks."""
import os
import sys
from urllib.parse import urlsplit

os.environ['WB_MAX_CONCURRENT_CHAT'] = '1'
os.environ['WB_CN_CHAT_UPSTREAM'] = 'https://www.workbuddy.cn'
os.environ['WB_ENABLE_FREE_MODEL_CREDIT_FALLBACK'] = '0'
os.environ['WB_ENABLE_ANTHROPIC_MESSAGES'] = '0'

import wb_proxy as gateway
import wb_scheduler


def idle(*args, **kwargs):
    return None


def harden():
    # No autonomous model probes, activity reports, reward tasks or update checks.
    wb_scheduler.Scheduler.start = idle
    gateway.start_catalog_daily = idle
    gateway.wb_pricing.PriceRefresher.start = idle
    gateway.wb_accounts.CreditsRefresher.start = idle
    gateway.wb_updates.UpdateChecker.start = idle
    gateway._report_first_run = lambda args: False
    gateway.auto_switch_product_enabled = lambda: False
    gateway._free_model_credit_fallback_enabled = lambda: False
    gateway.schedule_window_probe = lambda *args, **kwargs: False
    gateway.apply_prompt_mode = lambda messages: messages
    gateway.local_web_tools_enabled = lambda: False

    original_get = gateway.Handler.do_GET
    original_post = gateway.Handler.do_POST

    def read(handler):
        path = urlsplit(handler.path).path
        if path == '/health':
            ready = gateway.POOL.count_ready('cn') if gateway.POOL else 0
            return handler._json(200, {'service': 'qq-workbuddy', 'authenticated': bool(ready)})
        if path not in ('/v1/models', '/v1/balance-summary'):
            return handler._error(404, 'API-only service')
        return original_get(handler)

    def write(handler):
        if urlsplit(handler.path).path != '/v1/chat/completions':
            return handler._error(404, 'API-only service')
        return original_post(handler)

    gateway.Handler.do_GET = read
    gateway.Handler.do_POST = write


def main():
    if not os.environ.get('WB_PROXY_KEY'):
        raise SystemExit('WB_PROXY_KEY is required')
    harden()
    gateway.main()


if __name__ == '__main__':
    main()
