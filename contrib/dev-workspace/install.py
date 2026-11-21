#!/usr/bin/env python3
"""Install the personal Dev layout without replacing shipped files or restarting apps."""
import argparse
import datetime
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='write files (otherwise preview)')
    parser.add_argument('--app-home', type=Path, default=Path(os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app')))
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    root = here.parent.parent
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    files = [(here/'dev.json', 'layouts/dev.json'),
             (here/'dev-dark.json', 'themes/dev-dark.json'),
             (here/'dev-light.json', 'themes/dev-light.json')]
    # A personal copy of the tab bar survives startup's shipped-mod refresh.
    # Keep assets at their existing shipped paths; all are bundled with Herdr.
    files.extend((p, str(Path('mods/dev-tabs')/p.relative_to(root/'defaults/mods/tabs')))
                 for p in sorted((root/'defaults/mods/tabs').rglob('*')) if p.is_file())
    for source, relative in files:
        target = args.app_home.expanduser()/relative
        data = source.read_bytes()
        if target.exists() and target.read_bytes() == data:
            continue
        print(('write ' if args.apply else 'would write ')+str(target))
        if args.apply:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                target.with_name(target.name+'.bak-'+stamp).write_bytes(target.read_bytes())
            temporary = target.with_name(target.name+'.tmp-'+stamp)
            temporary.write_bytes(data)
            temporary.replace(target)
    print('Activate: herdr-app do layout.switch --name dev')
    print('Revert:   herdr-app do layout.switch --name main')


if __name__ == '__main__':
    main()
