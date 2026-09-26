import base64

from a2a.types import Part


def make_text_part(text: str) -> Part:
    """Create a text part using the installed A2A SDK."""
    return Part(text=text)


def make_file_part(data: str, mime_type: str) -> Part:
    """Decode a base64 attachment into an A2A file part."""
    return Part(raw=base64.b64decode(data), media_type=mime_type)
