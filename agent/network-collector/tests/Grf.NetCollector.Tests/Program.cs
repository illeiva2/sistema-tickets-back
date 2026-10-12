using System.Text.Json;
using Grf.NetCollector.Configuration;
using Grf.NetCollector.Contracts;
using Grf.NetCollector.Polling;
using Grf.NetCollector.RouterOs;
using Grf.NetCollector.Security;
using Grf.NetCollector.Snmp;
using Grf.NetCollector.Storage;
using Grf.NetCollector.Topology;
using Grf.NetCollector.UniFi;
using Lextm.SharpSnmpLib;

namespace Grf.NetCollector.Tests;

internal static class Program
{
    public static async Task<int> Main()
    {
        var tests = new (string Name, Func<Task> Run)[]
        {
            ("MAC se normaliza desde texto, bytes e índice SNMP", MacTest),
            ("RouterOS: velocidad y uptime se leen bien", RouterOsParsingTest),
            ("Tipo y orden de puertos por nombre de fábrica y por modelo", PortKindsTest),
            ("RouterOS: puertos, bond, PVID, vecinos y tabla MAC", RouterOsMappingTest),
            ("SNMP HPE: puertos físicos, LLDP por puerto de bridge, LAG y modelo", SnmpHpeTest),
            ("SNMP TP-Link: LLDP por nombre, índice sin timeMark y FDB por número de puerto", SnmpTpLinkTest),
            ("SNMP SwOS: la tabla MAC sobre agregados queda como lagNNN", SnmpSwOsLagTest),
            ("Modelo y firmware de SwOS, HPE y TP-Link", DescribeModelTest),
            ("UniFi: APs, estado, modelo comercial y vecino LLDP", UniFiMappingTest),
            ("Enlaces: árbol por tablas MAC y LLDP con el puerto exacto", LinkInferenceTreeTest),
            ("Enlaces: un AP de la última lectura de UniFi se ubica igual", LinkInferenceCachedApTest),
            ("Enlaces: el LLDP del AP sin puerto reconocible conserva el de la tabla MAC", LinkInferenceApLldpKeepsFdbPortTest),
            ("Enlaces: entre lecturas de UniFi el AP mantiene su enlace LLDP y sus clientes", LinkInferenceCachedApLldpTest),
            ("Estado: los vecinos LLDP de los APs se guardan y se leen", CollectorStateCachedNeighborsTest),
            ("Enlaces: MNDP no cuenta como conexión directa", LinkInferenceIgnoresMndpTest),
            ("Enlaces: la VLAN de gestión manda aunque otra VLAN entre por un AP", LinkInferenceManagementVlanTest),
            ("Equipos finales: puerto de acceso, Wi-Fi por AP, compartidos y VLAN excluida", EndpointInferenceTest),
            ("Equipos finales: gana el switch más profundo y nada queda en troncales", EndpointDeepestSwitchTest),
            ("RouterOS: concesiones DHCP con nombre e IP activa", RouterOsLeasesTest),
            ("Nombres de AP con y sin acentos coinciden", NormalizeNameTest),
            ("Certificados: huella anotada, primer uso y cambio", CertificatePinsTest),
            ("Configuración exige HTTPS, IPs válidas y drivers conocidos", ConfigurationTest),
            ("Contrato JSON en camelCase y sin nulls", SnapshotJsonTest),
            ("Línea de comandos reconoce las opciones", CliOptionsTest),
        };

        var failures = 0;
        foreach (var test in tests)
        {
            try
            {
                await test.Run().ConfigureAwait(false);
                Console.WriteLine($"PASS {test.Name}");
            }
            catch (Exception exception)
            {
                failures++;
                Console.Error.WriteLine($"FAIL {test.Name}: {exception.GetType().Name} - {exception.Message}");
            }
        }

        Console.WriteLine($"Resultado: {tests.Length - failures}/{tests.Length} pruebas correctas.");
        return failures == 0 ? 0 : 1;
    }

    private static Task MacTest()
    {
        Assert.Equal("74:4D:28:2C:B8:82", Mac.Normalize("74-4d-28-2c-b8-82"));
        Assert.Equal("74:4D:28:2C:B8:82", Mac.Normalize("744d.282c.b882"));
        Assert.Null(Mac.Normalize("192.168.33.24"));
        Assert.Null(Mac.Normalize("74:4D:28:2C:B8:82:00"));
        Assert.Equal("D0:67:26:A4:40:2A", Mac.FromBytes([0xD0, 0x67, 0x26, 0xA4, 0x40, 0x2A]));
        Assert.Equal("74:AC:B9:C3:DC:08", Mac.FromOidSuffix("200.116.172.185.195.220.8".Split('.')));
        return Task.CompletedTask;
    }

    private static Task RouterOsParsingTest()
    {
        Assert.Equal(10, RouterOsMapping.ParseRate("10Mbps"));
        Assert.Equal(1000, RouterOsMapping.ParseRate("1Gbps"));
        Assert.Equal(2500, RouterOsMapping.ParseRate("2.5Gbps"));
        Assert.Null(RouterOsMapping.ParseRate("auto"));
        Assert.Equal(4L * 604_800 + 6 * 86_400 + 16 * 3_600 + 34 * 60 + 21, RouterOsMapping.ParseUptime("4w6d16h34m21s"));
        Assert.Equal(21L * 604_800 + 23 * 3_600 + 37 * 60 + 1, RouterOsMapping.ParseUptime("21w23h37m1s"));
        Assert.Null(RouterOsMapping.ParseUptime(""));
        return Task.CompletedTask;
    }

    private static Task PortKindsTest()
    {
        Assert.Equal((PortKinds.Copper, 10), PortKinds.FromRouterOsDefaultName("ether10"));
        Assert.Equal((PortKinds.SfpPlus, 201), PortKinds.FromRouterOsDefaultName("sfp-sfpplus1"));
        Assert.Equal((PortKinds.Sfp, 102), PortKinds.FromRouterOsDefaultName("sfp2"));
        Assert.Equal((PortKinds.Combo, 3), PortKinds.FromRouterOsDefaultName("combo3"));
        Assert.Equal(PortKinds.Sfp, PortKinds.FromModel("OfficeConnect 1920S 48G 4SFP JL382A", 49, "49", null));
        Assert.Equal(PortKinds.Copper, PortKinds.FromModel("OfficeConnect 1920S 48G 4SFP JL382A", 48, "48", 1000));
        Assert.Equal(PortKinds.Sfp, PortKinds.FromModel("TL-SG2428P", 25, "gigabitEthernet 1/0/25", 1000));
        Assert.Equal(PortKinds.Combo, PortKinds.FromModel("CRS328-4C-20S-4S+", 2, "Taller-02", 1000));
        Assert.Equal(PortKinds.SfpPlus, PortKinds.FromModel("CRS328-4C-20S-4S+", 26, "Core-26", 10_000));
        Assert.Equal(PortKinds.Copper, PortKinds.FromModel(null, 1, "1", 1000));
        return Task.CompletedTask;
    }

    private static Dictionary<string, string> Row(params (string Key, string Value)[] fields) =>
        fields.ToDictionary(field => field.Key, field => field.Value, StringComparer.Ordinal);

    private static Task RouterOsMappingTest()
    {
        var readout = new RouterOsReadout
        {
            Identity = Row(("name", "SWITCH-CRS-TALLER")),
            Resource = Row(("version", "6.47.4 (stable)"), ("board-name", "CRS326-24G-2S+"), ("uptime", "15w2d17h52m27s")),
            RouterBoard = Row(("model", "CRS326-24G-2S+"), ("serial-number", "SERIE1")),
            Interfaces =
            [
                Row(("name", "ether10-UNIFI"), ("default-name", "ether10"), ("type", "ether"), ("mac-address", "74:4D:28:2C:B8:8B")),
                Row(("name", "sfp1-TRUNK"), ("default-name", "sfp-sfpplus1"), ("type", "ether"), ("mac-address", "74:4D:28:2C:B8:9A")),
                Row(("name", "sfp2-TRUNK"), ("default-name", "sfp-sfpplus2"), ("type", "ether"), ("mac-address", "74:4D:28:2C:B8:9B")),
                Row(("name", "bridge"), ("type", "bridge"), ("mac-address", "74:4D:28:2C:B8:81")),
            ],
            Ethernet =
            [
                Row(("name", "sfp1-TRUNK"), ("default-name", "sfp-sfpplus1"), ("running", "true"), ("disabled", "false"), ("mac-address", "74:4D:28:2C:B8:9A")),
                Row(("name", "ether10-UNIFI"), ("default-name", "ether10"), ("running", "true"), ("disabled", "false"), ("mac-address", "74:4D:28:2C:B8:8B"), ("comment", "AP del galpón")),
                Row(("name", "sfp2-TRUNK"), ("default-name", "sfp-sfpplus2"), ("running", "true"), ("disabled", "false"), ("mac-address", "74:4D:28:2C:B8:9B")),
                Row(("name", "ether12-UNIFI"), ("default-name", "ether12"), ("running", "false"), ("disabled", "true"), ("mac-address", "74:4D:28:2C:B8:8D")),
            ],
            Monitor =
            [
                Row(("name", "ether10-UNIFI"), ("status", "link-ok"), ("rate", "100Mbps"), ("full-duplex", "true")),
                Row(("name", "sfp1-TRUNK"), ("status", "link-ok"), ("rate", "1Gbps"), ("full-duplex", "true")),
                Row(("name", "sfp2-TRUNK"), ("status", "link-ok"), ("rate", "1Gbps"), ("full-duplex", "true")),
                Row(("name", "ether12-UNIFI"), ("status", "no-link")),
            ],
            BridgePorts = [Row(("interface", "ether10-UNIFI"), ("pvid", "1")), Row(("interface", "bond_TRUNK"), ("pvid", "999"))],
            Bonds = [Row(("name", "bond_TRUNK"), ("slaves", "sfp1-TRUNK,sfp2-TRUNK"))],
            Neighbors =
            [
                Row(("interface", "ether10-UNIFI,bridge"), ("identity", "AP-010-Taller-Galpn"), ("mac-address", "FC:EC:DA:3D:AF:54"), ("address", "10.1.1.66"), ("interface-name", "eth0")),
                Row(("interface", "sfp1-TRUNK,bond_TRUNK,bridge"), ("identity", "SWITCH-CRS-MOLINO"), ("platform", "MikroTik"), ("board", "CRS326-24G-2S+"), ("mac-address", "74:4D:28:2C:0E:57"), ("interface-name", "bridge/bond_TRUNK/sfp1-TRUNK")),
                Row(("interface", "vlan MGMT"), ("identity", "RB_MainRouter"), ("platform", "MikroTik"), ("address", "10.0.0.1")),
            ],
            BridgeHosts =
            [
                Row(("mac-address", "FC:EC:DA:3D:AF:54"), ("on-interface", "ether10-UNIFI"), ("vid", "1")),
                Row(("mac-address", "2C:C8:1B:87:82:CC"), ("on-interface", "bond_TRUNK"), ("vid", "999")),
                Row(("mac-address", "74:4D:28:2C:B8:81"), ("on-interface", "bridge"), ("local", "true")),
            ],
        };

        var result = RouterOsMapping.Build(new DeviceEntry { Ip = "10.0.0.3", Driver = "routeros", Role = "access" }, readout, 640);
        var snapshot = result.Snapshot;
        Assert.Equal("SWITCH-CRS-TALLER", snapshot.Name);
        Assert.Equal("RouterOS 6.47.4 (stable)", snapshot.Firmware);
        Assert.Equal("SERIE1", snapshot.SerialNumber);
        var ports = snapshot.Ports!;
        Assert.SequenceEqual(new[] { "ether10", "ether12", "sfp-sfpplus1", "sfp-sfpplus2" }, ports.Select(port => port.Key));
        var ether10 = ports[0];
        Assert.Equal("ether10-UNIFI", ether10.Name);
        Assert.Equal("AP del galpón", ether10.Description);
        Assert.True(ether10.LinkUp);
        Assert.Equal(100, ether10.SpeedMbps);
        Assert.Equal(1, ether10.Pvid);
        Assert.Equal("lldp", ether10.Neighbors![0].Protocol);
        Assert.Equal("10.1.1.66", ether10.Neighbors[0].Ip);
        var ether12 = ports[1];
        Assert.False(ether12.AdminUp);
        Assert.False(ether12.LinkUp);
        Assert.Null(ether12.SpeedMbps);
        Assert.Equal(999, ports[2].Pvid);
        Assert.Equal(PortKinds.SfpPlus, ports[2].Kind);
        Assert.Equal("mndp", ports[2].Neighbors![0].Protocol);
        Assert.Equal(2, result.Fdb.Count);
        Assert.SequenceEqual(new[] { "sfp-sfpplus1", "sfp-sfpplus2" }, result.Fdb.Single(entry => entry.Mac == "2C:C8:1B:87:82:CC").Ports);
        Assert.True(result.Macs.Contains("74:4D:28:2C:B8:81"));
        Assert.Equal("ether10", result.PortByMac["74:4D:28:2C:B8:8B"]);
        return Task.CompletedTask;
    }

    private static Dictionary<string, ISnmpData> Column(params (string Index, ISnmpData Value)[] cells) =>
        cells.ToDictionary(cell => cell.Index, cell => cell.Value, StringComparer.Ordinal);

    private static OctetString Bytes(params byte[] bytes) => new(bytes);

    private static Task SnmpHpeTest()
    {
        var hpeMac = Bytes(0xD0, 0x67, 0x26, 0xA4, 0x40, 0x2A);
        var columns = new Dictionary<string, Dictionary<string, ISnmpData>>
        {
            [Oids.IfDescr] = Column(("1", new OctetString("1 Gigabit - Level")), ("2", new OctetString("2 Gigabit - Level")), ("49", new OctetString("49 Gigabit - Level")), ("100", new OctetString("lag 1")), ("200", new OctetString("vlan 999"))),
            [Oids.IfName] = Column(("1", new OctetString("1")), ("2", new OctetString("2")), ("49", new OctetString("49")), ("100", new OctetString("l1")), ("200", new OctetString("vlan999"))),
            [Oids.IfType] = Column(("1", new Integer32(6)), ("2", new Integer32(6)), ("49", new Integer32(6)), ("100", new Integer32(161)), ("200", new Integer32(6))),
            [Oids.IfSpeed] = Column(("1", new Gauge32(1_000_000_000)), ("2", new Gauge32(0)), ("49", new Gauge32(1_000_000_000))),
            [Oids.IfHighSpeed] = Column(("1", new Gauge32(1000)), ("2", new Gauge32(0)), ("49", new Gauge32(1000))),
            [Oids.IfAdminStatus] = Column(("1", new Integer32(1)), ("2", new Integer32(1)), ("49", new Integer32(1))),
            [Oids.IfOperStatus] = Column(("1", new Integer32(1)), ("2", new Integer32(2)), ("49", new Integer32(1))),
            [Oids.IfPhysAddress] = Column(("1", hpeMac), ("2", hpeMac), ("49", hpeMac)),
            [Oids.BasePortIfIndex] = Column(("1", new Integer32(1)), ("2", new Integer32(2)), ("49", new Integer32(49)), ("100", new Integer32(100))),
            [Oids.QPvid] = Column(("1", new Integer32(200)), ("49", new Integer32(1))),
            [Oids.LagAttachedAggregator] = Column(("49", new Integer32(100))),
            [Oids.LldpLocPortId] = Column(("1", hpeMac), ("2", hpeMac)),
            [Oids.LldpRemChassisIdSubtype] = Column(("10484619.1.1869", new Integer32(4))),
            [Oids.LldpRemChassisId] = Column(("10484619.1.1869", Bytes(0x74, 0xAC, 0xB9, 0xC3, 0xDC, 0x08))),
            [Oids.LldpRemPortIdSubtype] = Column(("10484619.1.1869", new Integer32(3))),
            [Oids.LldpRemPortId] = Column(("10484619.1.1869", Bytes(0x74, 0xAC, 0xB9, 0xC3, 0xDC, 0x08))),
            [Oids.LldpRemPortDesc] = Column(("10484619.1.1869", new OctetString("eth0"))),
            [Oids.LldpRemSysName] = Column(("10484619.1.1869", new OctetString("AP-015-PasilloNorte"))),
            [Oids.LldpRemManAddrIfSubtype] = Column(("10484619.1.1869.1.4.10.1.1.51", new Integer32(2))),
            // AP en el puerto 1; el router (2C:C8:…) por el LAG 100 (puerto 49), VLAN 999.
            [Oids.QFdbPort] = Column(("1.116.172.185.195.220.8", new Integer32(1)), ("999.44.200.27.135.130.204", new Integer32(100)), ("1.208.103.38.164.64.41", new Integer32(0))),
            [Oids.QFdbStatus] = Column(("1.116.172.185.195.220.8", new Integer32(3)), ("999.44.200.27.135.130.204", new Integer32(3)), ("1.208.103.38.164.64.41", new Integer32(4))),
            [Oids.EntSerial] = Column(("1", new OctetString("SERIE-PRUEBA-01")), ("2", new OctetString(""))),
        };
        var readout = new SnmpReadout
        {
            Scalars = new Dictionary<string, ISnmpData>
            {
                [Oids.SysDescr] = new OctetString("HPE OfficeConnect Switch 1920S 48G 4SFP JL382A, PD.02.14, Linux 3.6.5-375bd0e8, U-Boot 2012.10"),
                [Oids.SysObjectId] = new ObjectIdentifier("1.3.6.1.4.1.11.2.3.7.11.185"),
                [Oids.SysName] = new OctetString("SWT-008"),
                [Oids.SysUpTime] = new TimeTicks(1_293_418_800),
                [Oids.BaseBridgeAddress] = Bytes(0xD0, 0x67, 0x26, 0xA4, 0x40, 0x28),
            },
            Columns = columns,
        };

        var result = SnmpMapping.Build(new DeviceEntry { Ip = "10.0.0.8", Driver = "snmp", Role = "access" }, readout, 380);
        var snapshot = result.Snapshot;
        Assert.Equal("SWT-008", snapshot.Name);
        Assert.Equal("HPE", snapshot.Vendor);
        Assert.Equal("OfficeConnect 1920S 48G 4SFP JL382A", snapshot.Model);
        Assert.Equal("PD.02.14", snapshot.Firmware);
        Assert.Equal("SERIE-PRUEBA-01", snapshot.SerialNumber);
        Assert.Equal(12_934_188L, snapshot.UptimeSeconds);
        Assert.Equal("D0:67:26:A4:40:28", snapshot.MacAddress);
        var ports = snapshot.Ports!;
        Assert.SequenceEqual(new[] { "1", "2", "49" }, ports.Select(port => port.Key));
        Assert.Equal(1000, ports[0].SpeedMbps);
        Assert.Equal(200, ports[0].Pvid);
        Assert.False(ports[1].LinkUp);
        Assert.Equal(PortKinds.Copper, ports[1].Kind);
        var neighbor = ports[0].Neighbors!.Single();
        Assert.Equal("AP-015-PasilloNorte", neighbor.Name);
        Assert.Equal("74:AC:B9:C3:DC:08", neighbor.Mac);
        Assert.Equal("10.1.1.51", neighbor.Ip);
        Assert.Equal("eth0", neighbor.Port);
        Assert.Equal(2, result.Fdb.Count);
        var routerEntry = result.Fdb.Single(entry => entry.Mac == "2C:C8:1B:87:82:CC");
        Assert.SequenceEqual(new[] { "49" }, routerEntry.Ports);
        Assert.Equal(999, routerEntry.Vlan);
        Assert.Equal(0, result.PortByMac.Count);
        return Task.CompletedTask;
    }

    private static Task SnmpTpLinkTest()
    {
        var mac = Bytes(0xE8, 0x48, 0xB8, 0x6A, 0x48, 0xE0);
        var columns = new Dictionary<string, Dictionary<string, ISnmpData>>
        {
            [Oids.IfDescr] = Column(("999", new OctetString("Vlan-interface999")), ("49153", new OctetString("gigabitEthernet 1/0/1")), ("49154", new OctetString("gigabitEthernet 1/0/2"))),
            [Oids.IfName] = Column(("999", new OctetString("Vlan-interface999")), ("49153", new OctetString("gigabitEthernet 1/0/1")), ("49154", new OctetString("gigabitEthernet 1/0/2"))),
            [Oids.IfType] = Column(("999", new Integer32(6)), ("49153", new Integer32(6)), ("49154", new Integer32(6))),
            [Oids.IfAlias] = Column(("999", new OctetString("MGMT")), ("49153", new OctetString("Unifi Oficina")), ("49154", new OctetString(""))),
            [Oids.IfHighSpeed] = Column(("49153", new Gauge32(0)), ("49154", new Gauge32(1000))),
            [Oids.IfOperStatus] = Column(("999", new Integer32(1)), ("49153", new Integer32(2)), ("49154", new Integer32(1))),
            [Oids.IfAdminStatus] = Column(("49153", new Integer32(1)), ("49154", new Integer32(1))),
            [Oids.IfPhysAddress] = Column(("999", mac), ("49153", mac), ("49154", mac)),
            [Oids.BasePortIfIndex] = Column(("49153", new Integer32(49153)), ("49154", new Integer32(49154))),
            [Oids.LldpLocPortId] = Column(("1", new OctetString("gigabitEthernet 1/0/1")), ("2", new OctetString("gigabitEthernet 1/0/2"))),
            [Oids.LldpRemChassisIdSubtype] = Column(("2.1", new Integer32(4))),
            [Oids.LldpRemChassisId] = Column(("2.1", Bytes(0xFC, 0xEC, 0xDA, 0x80, 0xFE, 0x29))),
            [Oids.LldpRemPortDesc] = Column(("2.1", new OctetString("eth0"))),
            [Oids.LldpRemSysName] = Column(("2.1", new OctetString("AP-008-CasaAnglica-Habitacines"))),
            [Oids.FdbPort] = Column(("252.236.218.128.254.41", new Integer32(49154))),
            // Este firmware numera la FDB de Q-BRIDGE por puerto físico (2 = gi1/0/2), no por 49154.
            [Oids.QFdbPort] = Column(("1.252.236.218.128.254.41", new Integer32(2)), ("999.44.200.27.135.130.204", new Integer32(25))),
        };
        var readout = new SnmpReadout
        {
            Scalars = new Dictionary<string, ISnmpData>
            {
                [Oids.SysDescr] = new OctetString("JetStream 28-Port Gigabit Smart Switch with 24-Port PoE+"),
                [Oids.SysObjectId] = new ObjectIdentifier("1.3.6.1.4.1.11863.5.98"),
                [Oids.SysName] = new OctetString("SWT-015"),
            },
            Columns = columns,
        };

        var result = SnmpMapping.Build(new DeviceEntry { Ip = "10.0.0.15", Driver = "snmp", Role = "access" }, readout, 3900);
        var ports = result.Snapshot.Ports!;
        Assert.Equal("TL-SG2428P", result.Snapshot.Model);
        Assert.Equal("TP-Link", result.Snapshot.Vendor);
        Assert.SequenceEqual(new[] { "49153", "49154" }, ports.Select(port => port.Key));
        Assert.Equal("Unifi Oficina", ports[0].Description);
        Assert.Equal(2, ports[1].Position);
        Assert.Equal("AP-008-CasaAnglica-Habitacines", ports[1].Neighbors!.Single().Name);
        // Con Q-BRIDGE presente se usa esa: el puerto 2 es el segundo físico; el 25 no existe en
        // este recorte (sólo hay 2 puertos), así que queda como agregado no detallado.
        var ap = result.Fdb.Single(entry => entry.Mac == "FC:EC:DA:80:FE:29");
        Assert.SequenceEqual(new[] { "49154" }, ap.Ports);
        Assert.Equal(1, ap.Vlan);
        Assert.SequenceEqual(new[] { "lag25" }, result.Fdb.Single(entry => entry.Mac == "2C:C8:1B:87:82:CC").Ports);
        return Task.CompletedTask;
    }

    private static Task SnmpSwOsLagTest()
    {
        // El SwOS informa casi toda su tabla MAC sobre puertos de bridge 130+ (sus LAG), que no
        // aparecen en dot1dBasePortIfIndex.
        var columns = new Dictionary<string, Dictionary<string, ISnmpData>>
        {
            [Oids.IfDescr] = Column(("1", new OctetString("Taller-01")), ("2", new OctetString("Taller-02")), ("24", new OctetString("Router"))),
            [Oids.IfName] = Column(("1", new OctetString("Taller-01")), ("2", new OctetString("Taller-02")), ("24", new OctetString("Router"))),
            [Oids.IfType] = Column(("1", new Integer32(6)), ("2", new Integer32(6)), ("24", new Integer32(6))),
            [Oids.IfOperStatus] = Column(("1", new Integer32(1)), ("2", new Integer32(1)), ("24", new Integer32(1))),
            [Oids.BasePortIfIndex] = Column(("1", new Integer32(1)), ("2", new Integer32(2)), ("24", new Integer32(24))),
            [Oids.FdbPort] = Column(("116.77.40.44.184.130", new Integer32(130)), ("44.200.27.135.130.204", new Integer32(24))),
            [Oids.FdbStatus] = Column(("116.77.40.44.184.130", new Integer32(3)), ("44.200.27.135.130.204", new Integer32(3))),
        };
        var readout = new SnmpReadout
        {
            Scalars = new Dictionary<string, ISnmpData>
            {
                [Oids.SysDescr] = new OctetString("CRS328-4C-20S-4S+ SwOS v2.13"),
                [Oids.SysName] = new OctetString("SWT-FO01"),
            },
            Columns = columns,
        };

        var result = SnmpMapping.Build(new DeviceEntry { Ip = "10.0.0.11", Driver = "snmp", Role = "core" }, readout, 300);
        Assert.SequenceEqual(new[] { "lag130" }, result.Fdb.Single(entry => entry.Mac == "74:4D:28:2C:B8:82").Ports);
        Assert.SequenceEqual(new[] { "24" }, result.Fdb.Single(entry => entry.Mac == "2C:C8:1B:87:82:CC").Ports);
        Assert.Equal(PortKinds.Combo, result.Snapshot.Ports![0].Kind);
        return Task.CompletedTask;
    }

    private static Task DescribeModelTest()
    {
        Assert.Equal(("CRS328-4C-20S-4S+", "SwOS 2.13"), SnmpMapping.DescribeModel("CRS328-4C-20S-4S+ SwOS v2.13", null, null));
        Assert.Equal(("OfficeConnect 1920S 24G 2SFP PoE+ (370W) JL385A", "PD.02.14"),
            SnmpMapping.DescribeModel("HPE OfficeConnect Switch 1920S 24G 2SFP PoE+ (370W) JL385A, PD.02.14, Linux 3.6.5", null, null));
        Assert.Equal(("TL-SG2428P", (string?)null), SnmpMapping.DescribeModel("JetStream 28-Port Gigabit Smart Switch with 24-Port PoE+", null, null));
        Assert.Equal("MikroTik", SnmpMapping.VendorFromObjectId("1.3.6.1.4.1.14988.2"));
        return Task.CompletedTask;
    }

    private static Task UniFiMappingTest()
    {
        using var document = JsonDocument.Parse("""
            [
              { "type": "uap", "mac": "fc:ec:da:3d:af:54", "name": "AP-010 - Taller - Galpón", "model": "U7LR", "ip": "10.1.1.66",
                "version": "6.6.77", "serial": "FCECDA3DAF54", "state": 1, "uptime": 3600, "num_sta": 4,
                "port_table": [ { "port_idx": 1, "name": "Main", "up": true, "speed": 100, "full_duplex": true } ],
                "lldp_table": [ { "chassis_id": "74:4d:28:2c:b8:81", "port_id": "74:4d:28:2c:b8:8b", "local_port_idx": 1 } ] },
              { "type": "uap", "mac": "fc:ec:da:00:00:07", "name": "AP-007 - CasaAngélica - Oficina", "model": "U7XYZ", "state": 0 },
              { "type": "ugw", "mac": "fc:ec:da:00:00:99", "name": "gateway" }
            ]
            """);
        var (devices, cache) = UniFiMapping.Build(document.RootElement, 1200);
        Assert.Equal(2, devices.Count);
        var ap = devices[0].Snapshot;
        Assert.Equal("ap-fc:ec:da:3d:af:54", ap.Key);
        Assert.Equal("UAP-AC-LR", ap.Model);
        Assert.Equal(4, ap.Clients);
        Assert.Equal("eth0", ap.Ports![0].Key);
        Assert.Equal(100, ap.Ports[0].SpeedMbps);
        Assert.Equal("74:4D:28:2C:B8:81", ap.Ports[0].Neighbors!.Single().Mac);
        var down = devices[1].Snapshot;
        Assert.False(down.Reachable);
        Assert.Equal("UniFi: desconectado", down.Error);
        Assert.Equal("U7XYZ", down.Model);
        Assert.Null(down.Clients);
        Assert.Equal(2, cache.Count);
        Assert.Equal("FC:EC:DA:3D:AF:54", cache[0].Mac);
        // El vecino LLDP queda guardado para las corridas que no leen UniFi; el del AP caído, no.
        var cached = cache[0].Neighbors!.Single();
        Assert.Equal("eth0", cached.Port);
        Assert.Equal("74:4D:28:2C:B8:81", cached.Neighbor.Mac);
        Assert.Null(cache[1].Neighbors);
        return Task.CompletedTask;
    }

    private static PollResult Device(string key, string role, string[] macs, (string Mac, string[] Ports)[] fdb, IReadOnlyList<PortSnapshot>? ports = null, string? name = null) => new()
    {
        Snapshot = new DeviceSnapshot
        {
            Key = key,
            Source = role == "ap" ? "unifi" : "routeros",
            Role = role,
            Reachable = true,
            Name = name ?? key,
            ManagementIp = role == "ap" ? null : key,
            Ports = ports ?? [],
        },
        Macs = macs.ToHashSet(),
        Fdb = fdb.Select(entry => new FdbEntry(entry.Mac, entry.Ports, null)).ToList(),
    };

    private static PortSnapshot Port(string key, params NeighborSnapshot[] neighbors) => new()
    {
        Key = key,
        Name = key,
        Position = 1,
        Kind = PortKinds.Copper,
        AdminUp = true,
        LinkUp = true,
        Neighbors = neighbors.Length == 0 ? null : neighbors,
    };

    private const string RouterMac = "2C:C8:1B:87:82:CC";
    private const string CoreMac = "08:55:31:CF:87:AD";
    private const string AccessMac = "74:4D:28:2C:B8:81";
    private const string EdgeMac = "D0:67:26:A4:40:28";
    private const string ApMac = "FC:EC:DA:3D:AF:54";

    /// <summary>router → core → access → edge → AP, visto desde las tablas MAC de cada uno.</summary>
    private static List<PollResult> Tree(bool withAp = true, NeighborSnapshot? edgeNeighbor = null)
    {
        var devices = new List<PollResult>
        {
            Device("10.0.0.1", "router", [RouterMac], [(CoreMac, ["ether1"]), (AccessMac, ["ether1"]), (EdgeMac, ["ether1"]), (ApMac, ["ether1"])]),
            Device("10.0.0.11", "core", [CoreMac], [(RouterMac, ["1"]), (AccessMac, ["3", "4"]), (EdgeMac, ["3", "4"]), (ApMac, ["3"])]),
            Device("10.0.0.3", "access", [AccessMac], [(RouterMac, ["sfp-sfpplus1", "sfp-sfpplus2"]), (EdgeMac, ["ether5"]), (ApMac, ["ether5"])]),
            Device("10.0.0.6", "access", [EdgeMac], [(RouterMac, ["49"]), (ApMac, ["10"])],
                ports: edgeNeighbor is null ? [] : [Port("10", edgeNeighbor)]),
        };
        if (withAp)
        {
            devices.Add(Device("ap-fc:ec:da:3d:af:54", "ap", [ApMac], [], ports: [Port("eth0")], name: "AP-010 - Taller - Galpón"));
        }

        return devices;
    }

    private static string Describe(LinkSnapshot link) =>
        $"{link.A.Device}[{string.Join("+", link.A.Ports)}]-{link.B.Device}[{string.Join("+", link.B.Ports)}]:{link.Source}";

    private static Task LinkInferenceTreeTest()
    {
        var links = LinkInference.Infer(Tree(edgeNeighbor: new NeighborSnapshot { Protocol = "lldp", Name = "AP-010-Taller-Galpn", Port = "eth0" }), []);
        Assert.SequenceEqual(
            new[]
            {
                "10.0.0.1[ether1]-10.0.0.11[1]:fdb",
                "10.0.0.11[3+4]-10.0.0.3[sfp-sfpplus1+sfp-sfpplus2]:fdb",
                "10.0.0.3[ether5]-10.0.0.6[49]:fdb",
                "10.0.0.6[10]-ap-fc:ec:da:3d:af:54[eth0]:lldp",
            },
            links.Select(Describe));
        return Task.CompletedTask;
    }

    private static Task LinkInferenceCachedApTest()
    {
        var links = LinkInference.Infer(Tree(withAp: false), [new CachedAp("ap-fc:ec:da:3d:af:54", ApMac, "AP-010 - Taller - Galpón")]);
        Assert.True(links.Any(link => Describe(link) == "10.0.0.6[10]-ap-fc:ec:da:3d:af:54[]:fdb"), string.Join(" | ", links.Select(Describe)));
        return Task.CompletedTask;
    }

    // Caso real del AP-016: el TP-Link Entrepiso no informa vecinos LLDP y el AP lo ve por LLDP con
    // la MAC del switch como "puerto" (la misma en todos los puertos), que no ubica nada.
    private static NeighborSnapshot SwitchWideLldp => new() { Protocol = "lldp", Mac = EdgeMac, Port = EdgeMac.ToLowerInvariant() };

    private static Task LinkInferenceApLldpKeepsFdbPortTest()
    {
        var devices = Tree();
        devices[4] = Device("ap-fc:ec:da:3d:af:54", "ap", [ApMac], [], ports: [Port("eth0", SwitchWideLldp)], name: "AP-010 - Taller - Galpón");
        var links = LinkInference.Infer(devices, []);
        Assert.True(links.Any(link => Describe(link) == "10.0.0.6[10]-ap-fc:ec:da:3d:af:54[eth0]:lldp"), string.Join(" | ", links.Select(Describe)));
        return Task.CompletedTask;
    }

    private static Task LinkInferenceCachedApLldpTest()
    {
        // Entre lecturas de UniFi (el AP no está en esta corrida) el enlace sale igual que con el AP leído.
        var cached = new CachedAp("ap-fc:ec:da:3d:af:54", ApMac, "AP-010 - Taller - Galpón", null, [new CachedNeighbor("eth0", SwitchWideLldp)]);
        var devices = Tree(withAp: false);
        devices[3] = Device("10.0.0.6", "access", [EdgeMac], [(RouterMac, ["49"]), (ApMac, ["10"]), (Wifi, ["10"])]);
        var links = LinkInference.Infer(devices, [cached]);
        Assert.True(links.Any(link => Describe(link) == "10.0.0.6[10]-ap-fc:ec:da:3d:af:54[eth0]:lldp"), string.Join(" | ", links.Select(Describe)));

        // Y el cliente Wi-Fi de ese puerto sigue siendo del AP.
        var wifi = EndpointInference.Infer(devices, [cached], links, new EndpointsSection()).Single();
        Assert.Equal("10.0.0.6/10 via ap-fc:ec:da:3d:af:54", $"{wifi.Device}/{wifi.Port} via {wifi.Via}");
        return Task.CompletedTask;
    }

    private static Task CollectorStateCachedNeighborsTest()
    {
        var path = Path.Combine(Path.GetTempPath(), $"grf-colector-estado-{Guid.NewGuid():N}.json");
        try
        {
            var state = new CollectorState();
            state.UniFi.Aps = [new CachedAp("ap-fc:ec:da:3d:af:54", ApMac, "AP-010", "10.1.1.66", [new CachedNeighbor("eth0", SwitchWideLldp)])];
            state.Save(path);
            var loaded = CollectorState.Load(path).UniFi.Aps.Single();
            Assert.Equal("eth0", loaded.Neighbors!.Single().Port);
            Assert.Equal(EdgeMac, loaded.Neighbors!.Single().Neighbor.Mac);

            // Un estado de la 0.2.0 (sin vecinos) se sigue leyendo.
            File.WriteAllText(path, """{ "pins": {}, "uniFi": { "aps": [ { "key": "ap-x", "mac": "FC:EC:DA:00:00:01", "name": "AP" } ] } }""");
            Assert.Null(CollectorState.Load(path).UniFi.Aps.Single().Neighbors);
        }
        finally
        {
            File.Delete(path);
        }

        return Task.CompletedTask;
    }

    private static Task LinkInferenceIgnoresMndpTest()
    {
        var devices = Tree();
        devices[2] = Device("10.0.0.3", "access", [AccessMac], [(RouterMac, ["sfp-sfpplus1"]), (EdgeMac, ["ether5"]), (ApMac, ["ether5"])],
            ports: [Port("sfp-sfpplus1", new NeighborSnapshot { Protocol = "mndp", Name = "10.0.0.6", Mac = EdgeMac })]);
        var links = LinkInference.Infer(devices, []);
        Assert.True(links.Single(link => link.A.Device == "10.0.0.3" && link.B.Device == "10.0.0.6").Source == "fdb");
        Assert.False(links.Any(link => link.A.Device == "10.0.0.3" && link.B.Device == "10.0.0.6" && link.A.Ports.Contains("sfp-sfpplus1")));
        return Task.CompletedTask;
    }

    private static Task LinkInferenceManagementVlanTest()
    {
        // Caso real del SWT-008: en la VLAN 1 la MAC del router entra por el puerto del AP-001
        // (el AP la trae por otro camino); en la VLAN de gestión (999) entra por el SFP 52.
        const string apKey = "ap-fc:ec:da:80:fe:30";
        const string apMacValue = "FC:EC:DA:80:FE:30";
        var router = new PollResult
        {
            Snapshot = new DeviceSnapshot { Key = "10.0.0.1", Source = "routeros", Role = "router", Reachable = true, ManagementIp = "10.0.0.1", Ports = [] },
            Macs = new HashSet<string> { RouterMac },
            Fdb = [new FdbEntry(CoreMac, ["ether1"], 999), new FdbEntry(EdgeMac, ["ether1"], 999), new FdbEntry(apMacValue, ["ether1"], 1)],
            Arp = [new ArpEntry("10.0.0.11", CoreMac, 999), new ArpEntry("10.0.0.8", EdgeMac, 999), new ArpEntry("10.1.1.62", apMacValue, 1)],
        };
        var core = new PollResult
        {
            Snapshot = new DeviceSnapshot { Key = "10.0.0.11", Source = "snmp", Role = "core", Reachable = true, ManagementIp = "10.0.0.11", Ports = [] },
            Macs = new HashSet<string> { CoreMac },
            Fdb = [new FdbEntry(RouterMac, ["24"], null), new FdbEntry(EdgeMac, ["19"], null), new FdbEntry(apMacValue, ["19"], null)],
        };
        var edge = new PollResult
        {
            Snapshot = new DeviceSnapshot
            {
                Key = "10.0.0.8", Source = "snmp", Role = "access", Reachable = true, ManagementIp = "10.0.0.8",
                Ports = [Port("12", new NeighborSnapshot { Protocol = "lldp", Mac = apMacValue, Name = "AP-001-Administracion-Box", Port = "eth0" })],
            },
            Macs = new HashSet<string> { EdgeMac },
            Fdb = [new FdbEntry(RouterMac, ["12"], 1), new FdbEntry(RouterMac, ["52"], 999), new FdbEntry(CoreMac, ["52"], 999), new FdbEntry(apMacValue, ["12"], 1)],
        };
        var ap = new PollResult
        {
            Snapshot = new DeviceSnapshot { Key = apKey, Source = "unifi", Role = "ap", Reachable = true, ManagementIp = "10.1.1.62", Name = "AP-001 - Administracion - Box", Ports = [Port("eth0")] },
            Macs = new HashSet<string> { apMacValue },
        };

        var links = LinkInference.Infer([router, core, edge, ap], []);
        Assert.SequenceEqual(
            new[]
            {
                "10.0.0.1[ether1]-10.0.0.11[24]:fdb",
                "10.0.0.11[19]-10.0.0.8[52]:fdb",
                $"10.0.0.8[12]-{apKey}[eth0]:lldp",
            },
            links.Select(Describe));
        return Task.CompletedTask;
    }

    private const string Pc1 = "AA:BB:CC:00:00:01";
    private const string Pc2 = "AA:BB:CC:00:00:02";
    private const string Phone = "AA:BB:CC:00:00:03";
    private const string Wifi = "AA:BB:CC:00:00:04";
    private const string Guest = "AA:BB:CC:00:00:05";

    /// <summary>
    /// Router → núcleo (SwOS, sin VLAN) → switch de acceso con: una PC en ether5, PC + teléfono en
    /// ether6, tres equipos en ether7 (switch sin gestión), y un AP en ether10 con un cliente Wi-Fi
    /// y un invitado (VLAN 300).
    /// </summary>
    private static (List<PollResult> Devices, List<LinkSnapshot> Links) AccessScenario()
    {
        var unmanaged = new[] { "AA:BB:CC:00:00:11", "AA:BB:CC:00:00:12", "AA:BB:CC:00:00:13" };
        var router = new PollResult
        {
            Snapshot = new DeviceSnapshot { Key = "10.0.0.1", Source = "routeros", Role = "router", Reachable = true, ManagementIp = "10.0.0.1", Ports = [] },
            Macs = new HashSet<string> { RouterMac },
            Fdb = [new FdbEntry(CoreMac, ["ether1"], 999), new FdbEntry(Pc1, ["ether1"], 200)],
            Arp = [new ArpEntry("192.168.100.41", Pc1, 200), new ArpEntry("192.168.90.7", Guest, 300), new ArpEntry("10.0.0.3", AccessMac, 999)],
            Leases = [new LeaseEntry(Pc1, "192.168.100.41", "PC-ADMIN-01"), new LeaseEntry(Wifi, "10.6.0.5", "celular")],
        };
        var core = new PollResult
        {
            Snapshot = new DeviceSnapshot { Key = "10.0.0.11", Source = "snmp", Role = "core", Reachable = true, ManagementIp = "10.0.0.11", Ports = [] },
            Macs = new HashSet<string> { CoreMac },
            Fdb = [new FdbEntry(RouterMac, ["24"], null), new FdbEntry(AccessMac, ["lag130"], null), new FdbEntry(Pc1, ["lag130"], null), new FdbEntry(Pc2, ["lag130"], null)],
        };
        var access = new PollResult
        {
            Snapshot = new DeviceSnapshot { Key = "10.0.0.3", Source = "routeros", Role = "access", Reachable = true, ManagementIp = "10.0.0.3", Ports = [] },
            Macs = new HashSet<string> { "74:4D:28:2C:B8:82" },
            Fdb =
            [
                new FdbEntry(RouterMac, ["sfp-sfpplus1", "sfp-sfpplus2"], 999),
                new FdbEntry(Pc1, ["ether5"], 200),
                new FdbEntry("01:00:5E:00:00:FB", ["ether5"], 200),
                new FdbEntry(Pc2, ["ether6"], 200),
                new FdbEntry(Phone, ["ether6"], 200),
                .. unmanaged.Select(mac => new FdbEntry(mac, ["ether7"], 200)),
                new FdbEntry(ApMac, ["ether10"], 1),
                new FdbEntry(Wifi, ["ether10"], 600),
                new FdbEntry(Guest, ["ether10"], 300),
            ],
        };
        var ap = new PollResult
        {
            Snapshot = new DeviceSnapshot { Key = "ap-fc:ec:da:3d:af:54", Source = "unifi", Role = "ap", Reachable = true, Ports = [] },
            Macs = new HashSet<string> { ApMac },
        };
        List<LinkSnapshot> links =
        [
            new(new LinkEnd("10.0.0.1", ["ether1"]), new LinkEnd("10.0.0.11", ["24"]), "fdb"),
            new(new LinkEnd("10.0.0.11", ["lag130"]), new LinkEnd("10.0.0.3", ["sfp-sfpplus1", "sfp-sfpplus2"]), "fdb"),
            new(new LinkEnd("10.0.0.3", ["ether10"]), new LinkEnd("ap-fc:ec:da:3d:af:54", ["eth0"]), "lldp"),
        ];
        return ([router, core, access, ap], links);
    }

    private static Task EndpointInferenceTest()
    {
        var (devices, links) = AccessScenario();
        var endpoints = EndpointInference.Infer(devices, [], links, new EndpointsSection { ExcludeVlans = [300] });
        string Describe(EndpointSnapshot endpoint) =>
            $"{endpoint.Mac}@{endpoint.Device}/{endpoint.Port}" +
            (endpoint.Via is null ? "" : $" via {endpoint.Via}") +
            (endpoint.Shared == true ? " compartido" : "");
        Assert.SequenceEqual(
            new[]
            {
                // Orden por equipo, puerto (texto) y MAC.
                $"{Wifi}@10.0.0.3/ether10 via ap-fc:ec:da:3d:af:54",
                $"{Pc1}@10.0.0.3/ether5",
                $"{Pc2}@10.0.0.3/ether6",
                $"{Phone}@10.0.0.3/ether6",
                "AA:BB:CC:00:00:11@10.0.0.3/ether7 compartido",
                "AA:BB:CC:00:00:12@10.0.0.3/ether7 compartido",
                "AA:BB:CC:00:00:13@10.0.0.3/ether7 compartido",
            },
            endpoints.Select(Describe));
        var pc = endpoints.Single(endpoint => endpoint.Mac == Pc1);
        Assert.Equal("192.168.100.41", pc.Ip);
        Assert.Equal("PC-ADMIN-01", pc.Hostname);
        Assert.Equal(200, pc.Vlan);
        var wifi = endpoints.Single(endpoint => endpoint.Mac == Wifi);
        Assert.Equal("10.6.0.5", wifi.Ip);
        Assert.Equal("celular", wifi.Hostname);
        Assert.Equal(0, EndpointInference.Infer(devices, [], links, new EndpointsSection { Enabled = false }).Count);
        return Task.CompletedTask;
    }

    private static Task EndpointDeepestSwitchTest()
    {
        // La PC aparece en un puerto "de acceso" del núcleo (mal leído) y en el ether5 del switch
        // de abajo: gana el de abajo, que es el más profundo.
        var (devices, links) = AccessScenario();
        var core = devices[1];
        devices[1] = new PollResult
        {
            Snapshot = core.Snapshot,
            Macs = core.Macs,
            Fdb = [.. core.Fdb, new FdbEntry(Pc1, ["5"], null)],
        };
        var endpoints = EndpointInference.Infer(devices, [], links, new EndpointsSection());
        Assert.Equal("10.0.0.3", endpoints.Single(endpoint => endpoint.Mac == Pc1).Device);
        Assert.False(endpoints.Any(endpoint => endpoint.Device == "10.0.0.1" || endpoint.Port.StartsWith("lag", StringComparison.Ordinal)));
        // Sin excluir la VLAN 300, el invitado aparece como cliente Wi-Fi.
        Assert.True(endpoints.Any(endpoint => endpoint.Mac == Guest && endpoint.Via is not null));
        return Task.CompletedTask;
    }

    private static Task RouterOsLeasesTest()
    {
        var readout = new RouterOsReadout
        {
            Identity = Row(("name", "RB_MainRouter")),
            DhcpLeases =
            [
                Row(("address", "192.168.100.41"), ("mac-address", "aa:bb:cc:00:00:01"), ("host-name", "PC-ADMIN-01"), ("status", "bound")),
                Row(("address", "10.6.0.0"), ("active-address", "10.6.0.5"), ("mac-address", "AA:BB:CC:00:00:04"), ("active-mac-address", "AA:BB:CC:00:00:04")),
                Row(("address", "10.6.0.9"), ("mac-address", "no-es-mac")),
            ],
        };
        var result = RouterOsMapping.Build(new DeviceEntry { Ip = "10.0.0.1", Driver = "routeros", Role = "router" }, readout, 100);
        Assert.Equal(2, result.Leases.Count);
        Assert.Equal(new LeaseEntry("AA:BB:CC:00:00:01", "192.168.100.41", "PC-ADMIN-01"), result.Leases[0]);
        Assert.Equal(new LeaseEntry("AA:BB:CC:00:00:04", "10.6.0.5", null), result.Leases[1]);
        return Task.CompletedTask;
    }

    private static Task NormalizeNameTest()
    {
        Assert.Equal(LinkInference.NormalizeName("AP-010 - Taller - Galpón"), LinkInference.NormalizeName("AP-010-Taller-Galpn"));
        Assert.Equal(LinkInference.NormalizeName("AP-008 - CasaAngélica - Habitaciónes"), LinkInference.NormalizeName("AP-008-CasaAnglica-Habitacines"));
        Assert.Null(LinkInference.NormalizeName("  "));
        return Task.CompletedTask;
    }

    private static Task CertificatePinsTest()
    {
        var state = new CollectorState();
        var pins = new CertificatePins(state);
        var first = new string('a', 64);
        var other = new string('b', 64);
        Assert.True(pins.Accept("10.0.0.3:8729", first, null));
        Assert.True(pins.Accept("10.0.0.3:8729", first.ToUpperInvariant(), null));
        Assert.False(pins.Accept("10.0.0.3:8729", other, null));
        Assert.True(pins.Accept("10.0.0.1:8729", other, string.Join(":", other.Chunk(2).Select(pair => new string(pair)))));
        Assert.False(pins.Accept("10.0.0.1:8729", first, other));
        return Task.CompletedTask;
    }

    private static Task ConfigurationTest()
    {
        var valid = new CollectorConfig
        {
            Api = new ApiSection { BaseUrl = "https://sistema-tickets-back.onrender.com", ClientSlug = "red-colector-srvdatos" },
            Devices = [new DeviceEntry { Ip = "10.0.0.1", Driver = "routeros", Role = "router" }],
            UniFi = new UniFiSection { Url = "https://172.31.16.41:8443" },
        };
        Assert.Equal(0, valid.Validate().Count);

        var invalid = new CollectorConfig
        {
            Api = new ApiSection { BaseUrl = "http://inseguro", ClientSlug = "X" },
            Devices =
            [
                new DeviceEntry { Ip = "10.0.0.300", Driver = "routeros" },
                new DeviceEntry { Ip = "10.0.0.6", Driver = "telnet" },
                new DeviceEntry { Ip = "10.0.0.6", Driver = "snmp", Role = "jefe", CertificateSha256 = "zz" },
            ],
        };
        var withBadVlan = new CollectorConfig
        {
            Api = valid.Api,
            Devices = valid.Devices,
            Endpoints = new EndpointsSection { ExcludeVlans = [5000] },
        };
        Assert.True(string.Join(" | ", withBadVlan.Validate()).Contains("ExcludeVlans", StringComparison.Ordinal));

        var errors = string.Join(" | ", invalid.Validate());
        foreach (var expected in new[] { "https", "ClientSlug", "no es una IP", "\"routeros\" o \"snmp\"", "repetida", "Role", "CertificateSha256" })
        {
            Assert.True(errors.Contains(expected, StringComparison.Ordinal), $"falta \"{expected}\" en: {errors}");
        }

        return Task.CompletedTask;
    }

    private static Task SnapshotJsonTest()
    {
        var payload = new SnapshotPayload(
            new CollectorInfo("0.1.0", "SRV-DATOS"),
            DateTimeOffset.Parse("2026-10-12T15:00:00Z", System.Globalization.CultureInfo.InvariantCulture),
            DateTimeOffset.Parse("2026-10-12T15:00:05Z", System.Globalization.CultureInfo.InvariantCulture),
            [new DeviceSnapshot { Key = "10.0.0.5", Source = "routeros", Role = "access", Reachable = false, Error = "sin conexión" }],
            [new LinkSnapshot(new LinkEnd("10.0.0.11", ["3"]), new LinkEnd("10.0.0.5", []), "fdb")],
            [new EndpointSnapshot { Mac = "AA:BB:CC:00:00:01", Device = "10.0.0.3", Port = "ether5", Vlan = 200 }]);
        var json = JsonSerializer.Serialize(payload, SnapshotJson.Options);
        Assert.True(json.Contains("\"endpoints\":[{\"mac\":\"AA:BB:CC:00:00:01\",\"device\":\"10.0.0.3\",\"port\":\"ether5\",\"vlan\":200}]", StringComparison.Ordinal), json);
        Assert.True(json.Contains("\"startedAt\":\"2026-10-12T15:00:00+00:00\"", StringComparison.Ordinal), json);
        Assert.True(json.Contains("\"reachable\":false", StringComparison.Ordinal), json);
        Assert.True(json.Contains("\"links\":[{\"a\":{\"device\":\"10.0.0.11\",\"ports\":[\"3\"]}", StringComparison.Ordinal), json);
        Assert.False(json.Contains("\"name\"", StringComparison.Ordinal), json);
        Assert.False(json.Contains("null", StringComparison.Ordinal), json);
        return Task.CompletedTask;
    }

    private static Task CliOptionsTest()
    {
        var options = CliOptions.Parse(["--dry-run", "--json", "salida.json", "--config", "c.json"]);
        Assert.True(options.DryRun);
        Assert.Equal("salida.json", options.JsonPath);
        Assert.Equal("c.json", options.ConfigPath);
        Assert.Null(options.Error);
        Assert.Equal("Argumento desconocido: --borrar", CliOptions.Parse(["--borrar"]).Error);
        return Task.CompletedTask;
    }
}

internal static class Assert
{
    public static void Equal<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"se esperaba <{expected}> y llegó <{actual}>");
        }
    }

    public static void SequenceEqual<T>(IEnumerable<T> expected, IEnumerable<T> actual)
    {
        var left = expected.ToList();
        var right = actual.ToList();
        if (!left.SequenceEqual(right))
        {
            throw new InvalidOperationException($"se esperaba [{string.Join(", ", left)}] y llegó [{string.Join(", ", right)}]");
        }
    }

    public static void True(bool condition, string? message = null)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message ?? "se esperaba verdadero");
        }
    }

    public static void False(bool condition, string? message = null) => True(!condition, message ?? "se esperaba falso");

    public static void Null(object? value)
    {
        if (value is not null)
        {
            throw new InvalidOperationException($"se esperaba null y llegó <{value}>");
        }
    }
}
