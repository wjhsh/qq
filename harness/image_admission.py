"""Local, deterministic image admission before any Chat network request.

This high-confidence text screen is intentionally small. It is not a complete
semantic moderation system and never disables the upstream safety checks.
"""
import re
import unicodedata


class ImageAdmissionError(ValueError):
    code = 'input_blocked'


def inspect_image_prompt(value):
    text = unicodedata.normalize('NFKC', str(value)).lower()
    text = re.sub(r'[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]', '', text)
    rules = [
        ('instruction_override', r'(?:忽略|无视|忘记|覆盖|绕过|解除|关闭)[\s\S]{0,45}(?:之前|以前|所有|系统|安全|开发者|审核|限制|规则|指令|提示词)'),
        ('instruction_override', r'(?:ignore|disregard|override|bypass|disable)[\s\S]{0,60}(?:previous|prior|system|developer|safety|policy|policies|instructions|restrictions)'),
        ('privilege_spoof', r'(?:你现在|从现在起|进入|开启|切换到)[\s\S]{0,35}(?:开发者模式|无审查模式|无限制模式|越狱模式|dan模式)'),
        ('privilege_spoof', r'(?:\[\s*system\s*\]|<\|(?:im_start|start_header_id)\|>\s*(?:system|developer)|^\s*(?:system|developer)\s*:)'),
        ('prompt_extraction', r'(?:逐字|完整|原样|一字不漏)[\s\S]{0,25}(?:输出|告诉|打印|复述|泄露)[\s\S]{0,25}(?:系统提示|系统指令|开发者提示|隐藏指令)'),
    ]
    for reason, pattern in rules:
        if re.search(pattern, text):
            return {'blocked': True, 'reason': reason}
    # Explicit avoidance clauses are constraints, not requests for that content.
    screened = re.sub(r'(?:不要|不含|禁止|避免|不得|不能有|没有)(?:任何|出现|包含|的)?\s*(?:色情|情色|裸露|裸体|露骨性内容|性行为|nsfw)(?:[、和与或及, ]+(?:色情|情色|裸露|裸体|露骨性内容|性行为|nsfw))*', '', text)
    screened = re.sub(r'\b(?:no|without|avoid)\s+(?:any\s+)?(?:nudity|nude\s+content|pornography|sexual\s+content|explicit\s+sex|nsfw)\b', '', screened)
    if re.search(r'色情|情色|淫秽|小黄[文图]|露骨性描写|性爱|性交|性器官|做爱|18禁|(?<![a-z])(?:nsfw|hentai|porn(?:ography|ographic)?|explicit\s+sex|sexual\s+intercourse)(?![a-z])', screened):
        return {'blocked': True, 'reason': 'explicit_sexual_request'}
    if re.search(r'(?:儿童|幼女|小学生|未成年)[\s\S]{0,60}(?:全裸|裸体|性感|性行为)', screened):
        return {'blocked': True, 'reason': 'sexualized_minor_request'}
    return {'blocked': False, 'reason': ''}


def require_image_prompt(value):
    verdict = inspect_image_prompt(value)
    if verdict['blocked']:
        raise ImageAdmissionError('本地输入安全检查已拦截这项生图要求，未发送到 Chat。')
    return verdict
