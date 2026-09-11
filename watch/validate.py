"""Check published state against the public schemas before any commit."""
import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]


def validate(talk, agents):
    for schema_name, documents in [('talk.schema.json', [talk]), ('agent-state.schema.json', agents)]:
        schema = json.loads((ROOT / 'schemas' / schema_name).read_text())
        checker = Draft202012Validator(schema, format_checker=FormatChecker())
        for document in documents:
            checker.validate(document)
            json.dumps(document, allow_nan=False)
    ids = [event['id'] for event in talk['lines'] if 'id' in event]
    if len(ids) != len(set(ids)):
        raise ValueError('duplicate message IDs')
    for agent in agents:
        if agent['id'] not in {'mara', 'codey', 'percy', 'big', 'aldric', 'nix', 'editor'}:
            raise ValueError('unknown agent identity')


if __name__ == '__main__':
    validate(json.loads((ROOT / 'talk.json').read_text()),
             [json.loads(p.read_text()) for p in (ROOT / 'agents').glob('*.json')])
    print('Published state is valid.')
