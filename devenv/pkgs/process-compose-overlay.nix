_final: prev: {
  process-compose = prev.process-compose.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./process-compose-vars-compare.patch ];
  });
}
