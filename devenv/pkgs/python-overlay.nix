_final: prev: {
  pythonPackagesExtensions = prev.pythonPackagesExtensions ++ [
    (pyfinal: _pyprev: {
      sushy-tools = pyfinal.callPackage ./sushy-tools.nix { };
    })
  ];
}
