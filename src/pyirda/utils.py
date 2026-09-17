import inspect


def _find_attrs(obj):
    """Iterate over all attributes of objects."""
    visited = set()

    if hasattr(obj, "__dict__"):
        for attr in sorted(obj.__dict__):
            if attr not in visited:
                yield attr
                visited.add(attr)

    for cls in reversed(inspect.getmro(obj.__class__)):
        if hasattr(cls, "__slots__"):
            for attr in cls.__slots__:
                if hasattr(obj, attr) and attr not in visited:
                    yield attr
                    visited.add(attr)


def _all_subclasses(cls):
    for sub in cls.__subclasses__():
        yield from _all_subclasses(sub)
        yield sub
