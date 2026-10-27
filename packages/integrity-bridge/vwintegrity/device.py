import re
import shlex
import subprocess
import time


class DeviceError(Exception):
    pass


class Device:
    def __init__(self, config):
        self.config = config
        self.package = config['package']

    def adb(self, *args, check=True, timeout=15):
        result = subprocess.run(
            [self.config['adb'], '-s', self.config['serial'], *args],
            capture_output=True, text=True, timeout=timeout,
        )
        if check and result.returncode:
            raise DeviceError('ADB_UNAVAILABLE')
        return result.stdout.strip()

    def shell(self, *args, **kwargs):
        return self.adb('shell', shlex.join(args), **kwargs)

    def pid(self, name):
        value = self.shell('pidof', name, check=False)
        return int(value.split()[0]) if value else None

    def ready(self):
        if self.shell('getprop', 'sys.boot_completed') != '1':
            raise DeviceError('DEVICE_NOT_BOOTED')
        version = self.shell('dumpsys', 'package', self.package)
        if not re.search(r'\bversionCode=' + re.escape(self.config['versionCode']) + r'\s', version):
            raise DeviceError('UNSUPPORTED_APP_VERSION')
        if not self.pid('frida-server'):
            server = shlex.quote(self.config['fridaServer'])
            self.shell('su', '-c', server + ' -D </dev/null >/dev/null 2>&1')
            for _ in range(20):
                if self.pid('frida-server'):
                    break
                time.sleep(.25)
            else:
                raise DeviceError('FRIDA_NOT_STARTED')
        pid = self.pid(self.package)
        if pid is None:
            self.shell('am', 'start', '-n', self.package + '/' + self.config['activity'])
            for _ in range(40):
                pid = self.pid(self.package)
                if pid is not None:
                    break
                time.sleep(.25)
            if pid is None:
                raise DeviceError('APP_NOT_STARTED')
            # ART changes collectors after a cold launch. Attaching during that
            # transition can crash HeapTaskDaemon on Android 16.
            time.sleep(10)
        if self.shell('cmd', 'activity', 'isfrozen', str(pid)) == 'true':
            self.shell('cmd', 'activity', 'unfreeze', str(pid))
        return pid
