# sushy-tools 2.2.0 isn't in nixpkgs either. Provides the sushy-emulator Redfish
# endpoint. 2.2.0 doesn't declare libvirt-python, but the emulator's libvirt
# driver imports it at runtime — add it explicitly.
{
  buildPythonPackage,
  fetchPypi,
  setuptools,
  pbr,
  flask,
  requests,
  tenacity,
  bcrypt,
  webob,
  libvirt,
}:
buildPythonPackage rec {
  pname = "sushy-tools";
  version = "2.2.0";
  pyproject = true;

  src = fetchPypi {
    pname = "sushy_tools";
    inherit version;
    sha256 = "b562ef8f2a08e14a7d7d1dd5d22101cb36652076ce8978bd0774ca1a368eada8";
  };

  build-system = [
    setuptools
    pbr
  ];

  propagatedBuildInputs = [
    flask
    requests
    tenacity
    bcrypt
    webob
    libvirt
  ];

  doCheck = false;
  pythonImportsCheck = [ "sushy_tools" ];

  meta.mainProgram = "sushy-emulator";
}
