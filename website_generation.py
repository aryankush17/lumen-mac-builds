"""Generate validated website copy; never execute model-produced HTML or scripts."""
import json
import re
import threading
import requests


class WebsiteGenerationError(ValueError):
    pass


_generation_lock = threading.Lock()


def validate_draft(data):
    if not isinstance(data, dict):
        raise WebsiteGenerationError('AI returned an invalid draft. Please try again.')
    limits = {'business': 120, 'headline': 400, 'description': 1200, 'action': 100, 'email': 254}
    result = {}
    for field, limit in limits.items():
        value = data.get(field)
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise WebsiteGenerationError('AI returned incomplete website content. Please try again.')
        result[field] = value.strip()
    if not re.fullmatch(r'[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', result['email']):
        raise WebsiteGenerationError('AI returned an invalid contact email. Please include the correct email in your brief.')
    services = data.get('services')
    if not isinstance(services, list) or not 1 <= len(services) <= 6:
        raise WebsiteGenerationError('AI returned an invalid service list. Please try again.')
    result['services'] = []
    for service in services:
        if not isinstance(service, dict):
            raise WebsiteGenerationError('AI returned an invalid service. Please try again.')
        item = {}
        for field, limit in [('title', 120), ('description', 800)]:
            value = service.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > limit:
                raise WebsiteGenerationError('AI returned an invalid service. Please try again.')
            item[field] = value.strip()
        result['services'].append(item)
    return result


def generate_draft(prompt, key):
    if not isinstance(prompt, str) or not 20 <= len(prompt.strip()) <= 6000:
        raise WebsiteGenerationError('Describe your website in 20–6,000 characters.')
    if not key:
        raise WebsiteGenerationError('Add your Groq API key in Lumen Settings, then try again.')
    if not _generation_lock.acquire(blocking=False):
        raise WebsiteGenerationError('A website is already being generated. Please wait for it to finish.')
    try:
        response = requests.post('https://api.groq.com/openai/v1/chat/completions',
            headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'},
            json={'model': 'openai/gpt-oss-120b', 'temperature': 0.7, 'max_completion_tokens': 3500,
                  'response_format': {'type': 'json_object'},
                  'messages': [
                      {'role': 'system', 'content': 'Create concise website copy from the user brief. Return ONLY JSON with business (string, max 120), headline (max 400), description (max 1200), action (max 100), email (valid email), services (1-6 objects with title max 120 and description max 800). All fields required. Use plain text, no HTML. Never invent awards, statistics, customer testimonials, qualifications or guarantees. Use hello@example.com when no email is supplied. Do not claim functionality like payments or bookings is connected.'},
                      {'role': 'user', 'content': prompt.strip()}]}, timeout=(10, 50))
        if response.status_code == 401:
            raise WebsiteGenerationError('Groq rejected the API key. Check it in Lumen Settings.')
        if response.status_code == 429:
            raise WebsiteGenerationError('Groq usage limit reached. Please wait or check your Groq allowance.')
        if response.status_code != 200:
            raise WebsiteGenerationError('Groq could not generate the website right now. Please try again later.')
        return validate_draft(json.loads(response.json()['choices'][0]['message']['content']))
    except requests.RequestException:
        raise WebsiteGenerationError('Could not reach Groq. Check your connection and try again.') from None
    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
        raise WebsiteGenerationError('AI returned an unreadable draft. Please try again.') from None
    finally:
        _generation_lock.release()
