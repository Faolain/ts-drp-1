module recordObserver {
  // Size compatibility only. Kind/authentication/codec/closure validity must
  // be established outside this scalar adjunct, not by these integer classes.
  pure val CUT = 0
  pure val QC = 1
  pure val TRUST = 2
  pure val sealRecordMaximum = 65536
  pure val trustRecordMaximum = 8192
  pure def requiredMaximum(kind:int):int =
    if(kind == CUT or kind == QC) sealRecordMaximum else trustRecordMaximum
  pure def observerAccepts(nativeMaximum:int, bytes:int):bool =
    bytes > 0 and bytes <= nativeMaximum
  pure def producerObserverCompatible(kind:int,nativeMaximum:int):bool =
    nativeMaximum == requiredMaximum(kind)
  run typedSealCeilingTest = producerObserverCompatible(CUT,65536).assert()
    .then(producerObserverCompatible(QC,65536).assert())
    .then(producerObserverCompatible(TRUST,8192).assert())
  run anchorCeilingCannotObserveCutTest =
    (not(producerObserverCompatible(CUT,8192)) and
      not(observerAccepts(8192,8749)) and observerAccepts(65536,8749)).assert()
  run oversizedRecordRefusesTest = (not(observerAccepts(65536,65537)) and
    not(observerAccepts(8192,8193)) and not(observerAccepts(65536,0))).assert()
}
