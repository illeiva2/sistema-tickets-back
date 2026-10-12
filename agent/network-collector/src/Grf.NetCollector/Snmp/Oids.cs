namespace Grf.NetCollector.Snmp;

/// <summary>Columnas estándar (IF-MIB, BRIDGE-MIB, Q-BRIDGE-MIB, LLDP-MIB, ENTITY-MIB, LAG-MIB).</summary>
internal static class Oids
{
    public const string SysDescr = "1.3.6.1.2.1.1.1.0";
    public const string SysObjectId = "1.3.6.1.2.1.1.2.0";
    public const string SysUpTime = "1.3.6.1.2.1.1.3.0";
    public const string SysName = "1.3.6.1.2.1.1.5.0";
    public const string BaseBridgeAddress = "1.3.6.1.2.1.17.1.1.0";

    public const string IfDescr = "1.3.6.1.2.1.2.2.1.2";
    public const string IfType = "1.3.6.1.2.1.2.2.1.3";
    public const string IfSpeed = "1.3.6.1.2.1.2.2.1.5";
    public const string IfPhysAddress = "1.3.6.1.2.1.2.2.1.6";
    public const string IfAdminStatus = "1.3.6.1.2.1.2.2.1.7";
    public const string IfOperStatus = "1.3.6.1.2.1.2.2.1.8";
    public const string IfName = "1.3.6.1.2.1.31.1.1.1.1";
    public const string IfHighSpeed = "1.3.6.1.2.1.31.1.1.1.15";
    public const string IfAlias = "1.3.6.1.2.1.31.1.1.1.18";
    public const string DuplexStatus = "1.3.6.1.2.1.10.7.2.1.19";

    public const string BasePortIfIndex = "1.3.6.1.2.1.17.1.4.1.2";
    public const string QPvid = "1.3.6.1.2.1.17.7.1.4.5.1.1";
    public const string QFdbPort = "1.3.6.1.2.1.17.7.1.2.2.1.2";
    public const string QFdbStatus = "1.3.6.1.2.1.17.7.1.2.2.1.3";
    public const string FdbPort = "1.3.6.1.2.1.17.4.3.1.2";
    public const string FdbStatus = "1.3.6.1.2.1.17.4.3.1.3";
    public const string LagAttachedAggregator = "1.2.840.10006.300.43.1.2.1.1.13";

    public const string LldpLocPortId = "1.0.8802.1.1.2.1.3.7.1.3";
    public const string LldpLocPortDesc = "1.0.8802.1.1.2.1.3.7.1.4";
    public const string LldpRemChassisIdSubtype = "1.0.8802.1.1.2.1.4.1.1.4";
    public const string LldpRemChassisId = "1.0.8802.1.1.2.1.4.1.1.5";
    public const string LldpRemPortIdSubtype = "1.0.8802.1.1.2.1.4.1.1.6";
    public const string LldpRemPortId = "1.0.8802.1.1.2.1.4.1.1.7";
    public const string LldpRemPortDesc = "1.0.8802.1.1.2.1.4.1.1.8";
    public const string LldpRemSysName = "1.0.8802.1.1.2.1.4.1.1.9";
    public const string LldpRemSysDesc = "1.0.8802.1.1.2.1.4.1.1.10";
    public const string LldpRemManAddrIfSubtype = "1.0.8802.1.1.2.1.4.2.1.3";

    public const string EntSoftwareRev = "1.3.6.1.2.1.47.1.1.1.1.10";
    public const string EntSerial = "1.3.6.1.2.1.47.1.1.1.1.11";
    public const string EntModelName = "1.3.6.1.2.1.47.1.1.1.1.13";

    /// <summary>Columnas que se recorren en cada sondeo (la FDB de BRIDGE-MIB sólo si falta la de Q-BRIDGE).</summary>
    public static readonly string[] Columns =
    [
        IfDescr, IfType, IfSpeed, IfPhysAddress, IfAdminStatus, IfOperStatus,
        IfName, IfHighSpeed, IfAlias, DuplexStatus,
        BasePortIfIndex, QPvid, QFdbPort, QFdbStatus, LagAttachedAggregator,
        LldpLocPortId, LldpLocPortDesc,
        LldpRemChassisIdSubtype, LldpRemChassisId, LldpRemPortIdSubtype, LldpRemPortId,
        LldpRemPortDesc, LldpRemSysName, LldpRemSysDesc, LldpRemManAddrIfSubtype,
        EntSoftwareRev, EntSerial, EntModelName,
    ];
}
