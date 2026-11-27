// Drives TIA Portal through Openness: verifies an exported bundle, imports it, or exports a project.
// Binds to the Siemens assemblies at run time, so one exe can load V17-V21 and builds without them.
// C# 5 only: this compiles with the csc.exe that ships with Windows.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Xml;
using Microsoft.Win32;

namespace PlcSmartIde.TiaBridge
{
    internal class Options
    {
        public string Command;
        public string Target;
        public string ProjectFile;
        public string OutDir;
        public string ApiDir;
        public string TiaVersion;
        public string CpuOverride;
        public bool ShowUi;
    }

    internal static class Program
    {
        private const int ExitOk = 0;
        private const int ExitInfrastructure = 1;
        private const int ExitProjectProblems = 2;

        private static readonly List<Assembly> SiemensAssemblies = new List<Assembly>();
        private static string apiDir;

        private static int Main(string[] args)
        {
            Options options;
            try
            {
                options = ParseArgs(args);
                Directory.CreateDirectory(options.OutDir);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
                if (ex is ArgumentException) PrintUsage();
                return ExitInfrastructure;
            }

            Report report = new Report(options.Command);
            int exitCode;
            try
            {
                LoadSiemensAssemblies(options, report);
                exitCode = Run(options, report) ? ExitOk : ExitProjectProblems;
            }
            catch (Exception ex)
            {
                report.Fatal = Describe(ex);
                Console.Error.WriteLine("FAILED: " + report.Fatal);
                exitCode = ExitInfrastructure;
            }

            try
            {
                string reportPath = Path.Combine(options.OutDir, "tia-report.json");
                File.WriteAllText(reportPath, report.ToJson(), new UTF8Encoding(false));
                Console.WriteLine("Report: " + reportPath);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Could not write tia-report.json: " + Describe(ex));
            }
            Console.WriteLine("Result: " + (exitCode == ExitOk ? "OK" : exitCode == ExitProjectProblems ? "TIA FOUND PROBLEMS" : "COULD NOT RUN"));
            return exitCode;
        }

        private static void PrintUsage()
        {
            Console.Error.WriteLine("Usage:");
            Console.Error.WriteLine("  TiaBridge verify <bundleDir> --out <dir>                  New project, import, compile, export back");
            Console.Error.WriteLine("  TiaBridge import <bundleDir> --project <file.apXX> --out <dir>  Import into a project and save it");
            Console.Error.WriteLine("  TiaBridge export --project <file.apXX> --out <dir>        Export blocks, types and tags");
            Console.Error.WriteLine("Options: --tia-version V19  --api-dir <folder>  --cpu \"OrderNumber:6ES7 .../V4.6\"  --ui");
        }

        private static Options ParseArgs(string[] args)
        {
            if (args.Length == 0) throw new ArgumentException("A command is required.");
            Options o = new Options();
            o.Command = args[0].ToLowerInvariant();
            if (o.Command != "verify" && o.Command != "import" && o.Command != "export")
                throw new ArgumentException("Unknown command: " + args[0]);

            for (int i = 1; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--ui") o.ShowUi = true;
                else if (a.StartsWith("--"))
                {
                    if (i + 1 >= args.Length) throw new ArgumentException("Missing value for " + a);
                    string value = args[++i];
                    if (a == "--out") o.OutDir = value;
                    else if (a == "--project") o.ProjectFile = value;
                    else if (a == "--api-dir") o.ApiDir = value;
                    else if (a == "--tia-version")
                    {
                        string v = value.Trim().ToUpperInvariant().TrimStart('V');
                        if (!Regex.IsMatch(v, @"^\d+(?:\.\d+)?$"))
                            throw new ArgumentException("Invalid --tia-version: " + value);
                        o.TiaVersion = v;
                    }
                    else if (a == "--cpu") o.CpuOverride = value;
                    else throw new ArgumentException("Unknown option: " + a);
                }
                else if (o.Target == null) o.Target = a;
                else throw new ArgumentException("Unexpected argument: " + a);
            }

            if (o.OutDir == null) throw new ArgumentException("--out is required.");
            if (o.Command != "export" && o.Target == null) throw new ArgumentException("The bundle folder is required.");
            if (o.Command != "verify" && o.ProjectFile == null) throw new ArgumentException("--project is required.");
            o.OutDir = Path.GetFullPath(o.OutDir);
            return o;
        }

        internal static string ResolveInsideBundle(string bundleFolder, string relativePath)
        {
            if (string.IsNullOrWhiteSpace(relativePath))
                throw new InvalidDataException("Bundle entry path cannot be empty.");
            if (Path.IsPathRooted(relativePath))
                throw new InvalidDataException("Bundle entry path cannot be rooted: " + relativePath);

            string fullRoot = Path.GetFullPath(bundleFolder);
            string sep = Path.DirectorySeparatorChar.ToString();
            string prefix = fullRoot.EndsWith(sep) ? fullRoot : fullRoot + sep;
            string fullTarget = Path.GetFullPath(Path.Combine(fullRoot, relativePath));
            if (!fullTarget.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Bundle entry path escapes bundle folder: " + relativePath);
            return fullTarget;
        }

        // ------------------------------------------------------------------
        // Locating and loading the Siemens assemblies
        // ------------------------------------------------------------------

        private static void LoadSiemensAssemblies(Options options, Report report)
        {
            string version;
            apiDir = options.ApiDir != null ? Path.GetFullPath(options.ApiDir) : FindApiDir(options.TiaVersion, out version);
            version = options.TiaVersion ?? VersionFromPath(apiDir);
            report.ApiDir = apiDir;
            report.TiaVersion = version;

            AppDomain.CurrentDomain.AssemblyResolve += ResolveFromApiDir;
            foreach (string dll in Directory.GetFiles(apiDir, "Siemens.Engineering*.dll"))
            {
                try
                {
                    SiemensAssemblies.Add(Assembly.LoadFrom(dll));
                }
                catch (Exception ex)
                {
                    report.Note("Could not load " + Path.GetFileName(dll) + ": " + ex.Message);
                }
            }
            if (SiemensAssemblies.Count == 0)
                throw new InvalidOperationException("No Siemens.Engineering assemblies in " + apiDir);
            Console.WriteLine("TIA Openness API: " + apiDir);
        }

        private static string FindApiDir(string requested, out string version)
        {
            List<string> versions = new List<string>();
            if (requested != null) versions.Add(requested);
            else for (int v = 21; v >= 17; v--) versions.Add(v.ToString());

            List<string> tried = new List<string>();
            foreach (string v in versions)
            {
                string root = ReadInstallPath(v) ?? Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "Siemens", "Automation", "Portal V" + v);
                foreach (string candidate in new[]
                {
                    Path.Combine(root, "PublicAPI", "V" + v, "net48"),
                    Path.Combine(root, "PublicAPI", "V" + v)
                })
                {
                    tried.Add(candidate);
                    if (Directory.Exists(candidate) && Directory.GetFiles(candidate, "Siemens.Engineering*.dll").Length > 0)
                    {
                        version = v;
                        return candidate;
                    }
                }
            }
            throw new DirectoryNotFoundException(
                "TIA Openness was not found. Tried:\n  " + string.Join("\n  ", tried) + "\nUse --api-dir to give the folder.");
        }

        private static string ReadInstallPath(string version)
        {
            try
            {
                using (RegistryKey hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (RegistryKey key = hklm.OpenSubKey(@"SOFTWARE\Siemens\Automation\_InstalledSW\TIAP" + version + @"\Global"))
                {
                    return key == null ? null : key.GetValue("Path") as string;
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string VersionFromPath(string path)
        {
            foreach (string part in path.Split(Path.DirectorySeparatorChar).Reverse())
            {
                int number;
                if (part.Length > 1 && part[0] == 'V' && int.TryParse(part.Substring(1), out number)) return number.ToString();
            }
            return null;
        }

        private static Assembly ResolveFromApiDir(object sender, ResolveEventArgs args)
        {
            string file = new AssemblyName(args.Name).Name + ".dll";
            string local = Path.Combine(apiDir, file);
            if (File.Exists(local)) return Assembly.LoadFrom(local);
            DirectoryInfo parentDir = Directory.GetParent(apiDir);
            if (parentDir == null) return null;
            string above = Path.Combine(parentDir.FullName, file);
            return File.Exists(above) ? Assembly.LoadFrom(above) : null;
        }

        private static Type FindType(string simpleName)
        {
            foreach (Assembly assembly in SiemensAssemblies)
            {
                Type[] types;
                try
                {
                    types = assembly.GetExportedTypes();
                }
                catch (ReflectionTypeLoadException ex)
                {
                    types = ex.Types.Where(t => t != null).ToArray();
                }
                foreach (Type t in types)
                {
                    if (t.Name == simpleName && t.Namespace != null && t.Namespace.StartsWith("Siemens.Engineering")) return t;
                }
            }
            throw new TypeLoadException("Type not found in the Openness API: " + simpleName);
        }

        private static dynamic EnumValue(string typeName, string value)
        {
            return Enum.Parse(FindType(typeName), value);
        }

        private static dynamic GetService(object target, string serviceName)
        {
            Type service = FindType(serviceName);
            List<Type> owners = new List<Type> { target.GetType() };
            owners.AddRange(target.GetType().GetInterfaces());
            foreach (Type owner in owners)
            {
                foreach (MethodInfo m in owner.GetMethods())
                {
                    if (m.Name == "GetService" && m.IsGenericMethodDefinition && m.GetParameters().Length == 0)
                        return m.MakeGenericMethod(service).Invoke(target, null);
                }
            }
            throw new MissingMethodException(target.GetType().FullName, "GetService<" + serviceName + ">");
        }

        // ------------------------------------------------------------------
        // Commands
        // ------------------------------------------------------------------

        private static bool Run(Options options, Report report)
        {
            dynamic mode = EnumValue("TiaPortalMode", options.ShowUi ? "WithUserInterface" : "WithoutUserInterface");
            dynamic portal = Activator.CreateInstance(FindType("TiaPortal"), new object[] { mode });
            try
            {
                if (options.Command == "verify") return RunVerify(portal, options, report);
                if (options.Command == "import") return RunImport(portal, options, report);
                return RunExport(portal, options, report);
            }
            finally
            {
                ((IDisposable)portal).Dispose();
            }
        }

        private static void SafeCloseProject(dynamic project)
        {
            if (project == null) return;
            try
            {
                project.Close();
            }
            catch (Exception)
            {
            }
        }

        private static bool RunVerify(dynamic portal, Options options, Report report)
        {
            Bundle bundle = Bundle.Load(options.Target);
            report.Project = bundle.ProjectName;
            report.Warnings.AddRange(bundle.Warnings);

            string projectRoot = Path.Combine(options.OutDir, "tia-project");
            Directory.CreateDirectory(projectRoot);
            string projectName = "Verify_" + DateTime.Now.ToString("yyyyMMdd_HHmmss");
            dynamic project = portal.Projects.Create(new DirectoryInfo(projectRoot), projectName);
            try
            {
                string typeIdentifier = options.CpuOverride ?? bundle.CpuTypeIdentifier;
                if (typeIdentifier == null) throw new InvalidOperationException("The bundle has no CPU. Use --cpu.");
                report.Cpu = typeIdentifier;
                dynamic device;
                try
                {
                    device = project.Devices.CreateWithItem(typeIdentifier, "PLC_1", "PLC_1");
                }
                catch (Exception ex)
                {
                    throw new InvalidOperationException(
                        "CPU '" + typeIdentifier + "' could not be created. This TIA may not have that firmware; try --cpu. " + Describe(ex));
                }
                dynamic plc = FindPlcSoftware(device);
                if (plc == null) throw new InvalidOperationException("The created device has no PLC software.");

                bool stepsOk = ImportBundle(plc, bundle, options, report);
                bool compiled = Compile(plc, report);
                ExportEverything(plc, Path.Combine(options.OutDir, "exported"), report);
                project.Save();
                return stepsOk && compiled;
            }
            finally
            {
                SafeCloseProject(project);
            }
        }

        private static bool RunImport(dynamic portal, Options options, Report report)
        {
            Bundle bundle = Bundle.Load(options.Target);
            report.Project = bundle.ProjectName;
            report.Warnings.AddRange(bundle.Warnings);

            dynamic project = portal.Projects.Open(new FileInfo(Path.GetFullPath(options.ProjectFile)));
            try
            {
                dynamic plc = FindFirstPlc(project);
                if (plc == null) throw new InvalidOperationException("The project has no PLC.");
                bool stepsOk = ImportBundle(plc, bundle, options, report);
                bool compiled = Compile(plc, report);
                if (stepsOk && compiled)
                {
                    project.Save();
                }
                else
                {
                    report.Note("Project was NOT saved because import or compilation failed.");
                }
                return stepsOk && compiled;
            }
            finally
            {
                SafeCloseProject(project);
            }
        }

        private static bool RunExport(dynamic portal, Options options, Report report)
        {
            dynamic project = portal.Projects.Open(new FileInfo(Path.GetFullPath(options.ProjectFile)));
            try
            {
                report.Project = Path.GetFileNameWithoutExtension(options.ProjectFile);
                dynamic plc = FindFirstPlc(project);
                if (plc == null) throw new InvalidOperationException("The project has no PLC.");
                bool compiled = Compile(plc, report);
                ExportEverything(plc, options.OutDir, report);
                return compiled;
            }
            finally
            {
                SafeCloseProject(project);
            }
        }

        private static dynamic FindFirstPlc(dynamic project)
        {
            foreach (dynamic device in project.Devices)
            {
                dynamic plc = FindPlcSoftware(device);
                if (plc != null) return plc;
            }
            return null;
        }

        private static dynamic FindPlcSoftware(dynamic parent)
        {
            foreach (dynamic item in parent.DeviceItems)
            {
                dynamic container = null;
                try
                {
                    container = GetService((object)item, "SoftwareContainer");
                }
                catch (TargetInvocationException)
                {
                }
                if (container != null)
                {
                    object software = container.Software;
                    if (software != null && software.GetType().Name == "PlcSoftware") return software;
                }
                dynamic nested = FindPlcSoftware(item);
                if (nested != null) return nested;
            }
            return null;
        }

        private static bool ImportBundle(dynamic plc, Bundle bundle, Options options, Report report)
        {
            bool ok = true;
            int tagIndex = 0;
            foreach (TagTableEntry table in bundle.TagTables)
            {
                tagIndex++;
                StepResult step = report.AddStep("tags", table.Name, table.File);
                try
                {
                    string safePath = ResolveInsideBundle(bundle.Folder, table.File);
                    string prepared = WriteTagTableForThisTia(safePath, report.TiaVersion, options.OutDir, tagIndex);
                    plc.TagTableGroup.TagTables.Import(new FileInfo(prepared), EnumValue("ImportOptions", "Override"));
                    step.Ok = true;
                }
                catch (Exception ex)
                {
                    ok = Fail(step, ex);
                }
            }

            foreach (StepEntry entry in bundle.Steps)
            {
                StepResult step = report.AddStep(entry.Kind, entry.Name, entry.File);
                dynamic source = null;
                try
                {
                    string full = ResolveInsideBundle(bundle.Folder, entry.File);
                    string sourceName = Path.GetFileName(entry.File);
                    source = plc.ExternalSourceGroup.ExternalSources.CreateFromFile(sourceName, full);
                    source.GenerateBlocksFromSource();
                    step.Ok = true;
                    if (entry.Number.HasValue && entry.Kind != "udt") SetBlockNumber(plc, entry, step);
                }
                catch (Exception ex)
                {
                    ok = Fail(step, ex);
                }
                finally
                {
                    if (source != null)
                    {
                        try
                        {
                            source.Delete();
                        }
                        catch (Exception ex)
                        {
                            step.Notes.Add("Source was left in the project: " + ex.Message);
                        }
                    }
                }
            }
            return ok;
        }

        private static bool Fail(StepResult step, Exception ex)
        {
            step.Ok = false;
            step.Error = Describe(ex);
            Console.Error.WriteLine("  FAILED " + step.Name + ": " + step.Error);
            return false;
        }

        /// <summary>TIA rejects SimaticML that states another version, so the file gets the running version.</summary>
        private static string WriteTagTableForThisTia(string path, string version, string outDir, int index)
        {
            XmlDocument doc = new XmlDocument();
            doc.XmlResolver = null;
            doc.PreserveWhitespace = true;
            doc.Load(path);

            if (version != null)
            {
                XmlNode eng = doc.SelectSingleNode("//Engineering");
                if (eng != null && eng.Attributes != null)
                {
                    XmlAttribute attr = eng.Attributes["version"];
                    if (attr != null) attr.Value = "V" + version;
                }
            }

            string folder = Path.Combine(outDir, "prepared-tags");
            Directory.CreateDirectory(folder);
            string baseName = Path.GetFileName(path);
            string prepared = Path.Combine(folder, index.ToString("D3") + "_" + baseName);
            using (XmlTextWriter writer = new XmlTextWriter(prepared, new UTF8Encoding(false)))
            {
                doc.WriteTo(writer);
            }
            return prepared;
        }

        private static dynamic FindBlockRecursive(dynamic group, string name)
        {
            dynamic block = group.Blocks.Find(name);
            if (block != null) return block;
            foreach (dynamic child in group.Groups)
            {
                dynamic nested = FindBlockRecursive(child, name);
                if (nested != null) return nested;
            }
            return null;
        }

        private static void SetBlockNumber(dynamic plc, StepEntry entry, StepResult step)
        {
            try
            {
                dynamic block = FindBlockRecursive(plc.BlockGroup, entry.Name);
                if (block == null)
                {
                    step.Notes.Add("Block was not found after generation, so its number was not set.");
                    return;
                }
                block.SetAttribute("AutoNumber", false);
                block.SetAttribute("Number", entry.Number.Value);
            }
            catch (Exception ex)
            {
                step.Notes.Add("Number " + entry.Number.Value + " could not be set: " + Describe(ex));
            }
        }

        private static bool Compile(dynamic plc, Report report)
        {
            dynamic compiler = GetService((object)plc, "ICompilable");
            dynamic result = compiler.Compile();
            report.CompileState = result.State.ToString();
            report.CompileErrors = (int)result.ErrorCount;
            report.CompileWarnings = (int)result.WarningCount;
            CollectMessages(result.Messages, "", report);
            Console.WriteLine("Compile: " + report.CompileState + ", " + report.CompileErrors + " error(s), " + report.CompileWarnings + " warning(s)");
            return report.CompileState == "Success" || report.CompileState == "Warning";
        }

        private static void CollectMessages(dynamic messages, string parentPath, Report report)
        {
            foreach (dynamic message in messages)
            {
                string path = (string)message.Path;
                string fullPath = string.IsNullOrEmpty(parentPath) ? path : parentPath + " > " + path;
                string description = (string)message.Description;
                if (!string.IsNullOrEmpty(description))
                {
                    Dictionary<string, object> row = new Dictionary<string, object>();
                    row["state"] = message.State.ToString();
                    row["path"] = fullPath;
                    row["description"] = description;
                    report.Messages.Add(row);
                }
                CollectMessages(message.Messages, fullPath, report);
            }
        }

        // ------------------------------------------------------------------
        // Export
        // ------------------------------------------------------------------

        private static string UniqueFile(HashSet<string> used, string safeBase, string extension)
        {
            string candidate = safeBase + extension;
            int n = 2;
            while (!used.Add(candidate))
            {
                candidate = safeBase + "_" + n + extension;
                n++;
            }
            return candidate;
        }

        private static void ExportEverything(dynamic plc, string root, Report report)
        {
            string xmlDir = Path.Combine(root, "xml");
            string sourcesDir = Path.Combine(root, "sources");
            string tagsDir = Path.Combine(root, "tags");
            Directory.CreateDirectory(xmlDir);
            Directory.CreateDirectory(sourcesDir);
            Directory.CreateDirectory(tagsDir);

            HashSet<string> usedXml = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            HashSet<string> usedSources = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            HashSet<string> usedTags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            List<Dictionary<string, object>> steps = new List<Dictionary<string, object>>();
            List<Dictionary<string, object>> tagTables = new List<Dictionary<string, object>>();
            ExportBlockGroup(plc, plc.BlockGroup, xmlDir, sourcesDir, usedXml, usedSources, steps, report);
            ExportTypeGroup(plc, plc.TypeGroup, xmlDir, sourcesDir, usedXml, usedSources, steps, report);
            ExportTagGroup(plc.TagTableGroup, tagsDir, usedTags, tagTables, report);

            Dictionary<string, object> manifest = new Dictionary<string, object>();
            manifest["formatVersion"] = 1;
            manifest["project"] = report.Project;
            manifest["cpu"] = null;
            manifest["tagTables"] = tagTables;
            manifest["steps"] = steps;
            manifest["skipped"] = new object[0];
            manifest["warnings"] = new object[0];
            JavaScriptSerializer json = new JavaScriptSerializer();
            json.MaxJsonLength = int.MaxValue;
            File.WriteAllText(Path.Combine(root, "manifest.json"), json.Serialize(manifest), new UTF8Encoding(false));
        }

        private static void ExportBlockGroup(dynamic plc, dynamic group, string xmlDir, string sourcesDir,
            HashSet<string> usedXml, HashSet<string> usedSources, List<Dictionary<string, object>> steps, Report report)
        {
            foreach (dynamic block in group.Blocks)
            {
                string name = (string)block.Name;
                string kind = BlockKind(block);
                string xmlFile = UniqueFile(usedXml, SafeName(name), ".xml");
                ExportXml(block, Path.Combine(xmlDir, xmlFile), name, report);

                string language = "";
                try
                {
                    language = block.ProgrammingLanguage.ToString();
                }
                catch (Exception)
                {
                }
                bool hasText = language == "SCL" || language == "DB";
                if (!hasText)
                {
                    report.Exported.Add(name + " (" + language + "): XML only");
                    continue;
                }
                string extension = kind == "db" ? ".db" : ".scl";
                string file = UniqueFile(usedSources, SafeName(name), extension);
                if (GenerateSource(plc, "PlcBlock", (object)block, Path.Combine(sourcesDir, file), name, report))
                {
                    Dictionary<string, object> step = new Dictionary<string, object>();
                    step["file"] = "sources/" + file;
                    step["kind"] = kind;
                    step["name"] = name;
                    step["number"] = (int)block.Number;
                    steps.Add(step);
                }
            }
            foreach (dynamic child in group.Groups)
                ExportBlockGroup(plc, child, xmlDir, sourcesDir, usedXml, usedSources, steps, report);
        }

        private static void ExportTypeGroup(dynamic plc, dynamic group, string xmlDir, string sourcesDir,
            HashSet<string> usedXml, HashSet<string> usedSources, List<Dictionary<string, object>> steps, Report report)
        {
            foreach (dynamic type in group.Types)
            {
                string name = (string)type.Name;
                string xmlFile = UniqueFile(usedXml, SafeName(name), ".type.xml");
                ExportXml(type, Path.Combine(xmlDir, xmlFile), name, report);
                string file = UniqueFile(usedSources, SafeName(name), ".udt");
                if (GenerateSource(plc, "PlcType", (object)type, Path.Combine(sourcesDir, file), name, report))
                {
                    Dictionary<string, object> step = new Dictionary<string, object>();
                    step["file"] = "sources/" + file;
                    step["kind"] = "udt";
                    step["name"] = name;
                    steps.Add(step);
                }
            }
            foreach (dynamic child in group.Groups)
                ExportTypeGroup(plc, child, xmlDir, sourcesDir, usedXml, usedSources, steps, report);
        }

        private static void ExportTagGroup(dynamic group, string tagsDir, HashSet<string> usedTags,
            List<Dictionary<string, object>> tables, Report report)
        {
            foreach (dynamic table in group.TagTables)
            {
                string name = (string)table.Name;
                string file = UniqueFile(usedTags, SafeName(name), ".xml");
                if (ExportXml(table, Path.Combine(tagsDir, file), name, report))
                {
                    Dictionary<string, object> row = new Dictionary<string, object>();
                    row["file"] = "tags/" + file;
                    row["name"] = name;
                    tables.Add(row);
                }
            }
            foreach (dynamic child in group.Groups)
                ExportTagGroup(child, tagsDir, usedTags, tables, report);
        }

        private static bool ExportXml(dynamic item, string path, string name, Report report)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
                item.Export(new FileInfo(path), EnumValue("ExportOptions", "WithDefaults"));
                report.Exported.Add(name + ": " + Path.GetFileName(path));
                return true;
            }
            catch (Exception ex)
            {
                report.Note("Export of " + name + " failed: " + Describe(ex));
                return false;
            }
        }

        private static bool GenerateSource(dynamic plc, string elementType, object item, string path, string name, Report report)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
                Array items = Array.CreateInstance(FindType(elementType), 1);
                items.SetValue(item, 0);
                dynamic typedItems = items;
                plc.ExternalSourceGroup.GenerateSource(typedItems, new FileInfo(path), EnumValue("GenerateOptions", "None"));
                report.Exported.Add(name + ": " + Path.GetFileName(path));
                return true;
            }
            catch (Exception ex)
            {
                report.Note("Source of " + name + " was not generated: " + Describe(ex));
                return false;
            }
        }

        private static string BlockKind(dynamic block)
        {
            string typeName = ((object)block).GetType().Name;
            if (typeName == "OB") return "ob";
            if (typeName == "FB") return "fb";
            if (typeName == "FC") return "fc";
            return "db";
        }

        private static string SafeName(string name)
        {
            StringBuilder safe = new StringBuilder();
            foreach (char c in name) safe.Append(char.IsLetterOrDigit(c) || c == '_' || c == '-' ? c : '_');
            return safe.Length > 0 ? safe.ToString() : "Unnamed";
        }

        private static string Describe(Exception ex)
        {
            while (ex is TargetInvocationException && ex.InnerException != null) ex = ex.InnerException;
            return ex.GetType().Name + ": " + ex.Message;
        }
    }

    // ----------------------------------------------------------------------
    // Reading the bundle
    // ----------------------------------------------------------------------

    internal class StepEntry
    {
        public string File;
        public string Kind;
        public string Name;
        public int? Number;
    }

    internal class TagTableEntry
    {
        public string File;
        public string Name;
    }

    internal class Bundle
    {
        public string Folder;
        public string ProjectName;
        public string CpuTypeIdentifier;
        public readonly List<StepEntry> Steps = new List<StepEntry>();
        public readonly List<TagTableEntry> TagTables = new List<TagTableEntry>();
        public readonly List<string> Warnings = new List<string>();

        public static Bundle Load(string folder)
        {
            string full = Path.GetFullPath(folder);
            string manifestPath = Path.Combine(full, "manifest.json");
            if (!System.IO.File.Exists(manifestPath)) throw new FileNotFoundException("manifest.json not found in " + full);

            JavaScriptSerializer json = new JavaScriptSerializer();
            json.MaxJsonLength = int.MaxValue;
            Dictionary<string, object> root = json.Deserialize<Dictionary<string, object>>(
                System.IO.File.ReadAllText(manifestPath, Encoding.UTF8));
            if (root == null) throw new InvalidDataException("manifest.json is empty or not a JSON object.");

            Bundle bundle = new Bundle();
            bundle.Folder = full;
            bundle.ProjectName = root.ContainsKey("project") ? root["project"] as string : null;

            Dictionary<string, object> cpu = root.ContainsKey("cpu") ? root["cpu"] as Dictionary<string, object> : null;
            if (cpu != null)
            {
                string orderNumber = OptionalString(cpu, "orderNumber");
                string firmware = OptionalString(cpu, "firmware");
                if (!string.IsNullOrWhiteSpace(orderNumber) && !string.IsNullOrWhiteSpace(firmware))
                    bundle.CpuTypeIdentifier = "OrderNumber:" + orderNumber + "/" + firmware;
            }
            foreach (object item in AsList(root, "tagTables"))
            {
                Dictionary<string, object> row = RequireDict(item, "tagTables entry");
                TagTableEntry table = new TagTableEntry();
                table.File = RequireString(row, "file", "tagTables entry");
                table.Name = RequireString(row, "name", "tagTables entry");
                Program.ResolveInsideBundle(bundle.Folder, table.File);
                bundle.TagTables.Add(table);
            }
            foreach (object item in AsList(root, "steps"))
            {
                Dictionary<string, object> row = RequireDict(item, "steps entry");
                StepEntry step = new StepEntry();
                step.File = RequireString(row, "file", "steps entry");
                step.Kind = RequireString(row, "kind", "steps entry");
                step.Name = RequireString(row, "name", "steps entry");
                Program.ResolveInsideBundle(bundle.Folder, step.File);
                if (row.ContainsKey("number") && row["number"] != null) step.Number = Convert.ToInt32(row["number"]);
                bundle.Steps.Add(step);
            }
            foreach (object item in AsList(root, "warnings"))
            {
                if (item != null) bundle.Warnings.Add(item.ToString());
            }
            foreach (object item in AsList(root, "skipped"))
            {
                Dictionary<string, object> row = item as Dictionary<string, object>;
                if (row != null)
                    bundle.Warnings.Add("Skipped " + OptionalString(row, "name") + ": " + OptionalString(row, "reason"));
            }
            return bundle;
        }

        private static Dictionary<string, object> RequireDict(object value, string context)
        {
            Dictionary<string, object> dict = value as Dictionary<string, object>;
            if (dict == null) throw new InvalidDataException("Expected object in " + context);
            return dict;
        }

        private static string RequireString(Dictionary<string, object> dict, string key, string context)
        {
            object value;
            if (!dict.TryGetValue(key, out value) || !(value is string) || string.IsNullOrWhiteSpace((string)value))
                throw new InvalidDataException("Missing string '" + key + "' in " + context);
            return (string)value;
        }

        private static string OptionalString(Dictionary<string, object> dict, string key)
        {
            object value;
            if (dict != null && dict.TryGetValue(key, out value) && value != null) return value.ToString();
            return "";
        }

        private static IEnumerable AsList(Dictionary<string, object> root, string key)
        {
            object value;
            if (root != null && root.TryGetValue(key, out value) && value is IEnumerable && !(value is string))
                return (IEnumerable)value;
            return new object[0];
        }
    }

    // ----------------------------------------------------------------------
    // The report the user brings back
    // ----------------------------------------------------------------------

    internal class StepResult
    {
        public string Kind;
        public string Name;
        public string File;
        public bool Ok;
        public string Error;
        public readonly List<string> Notes = new List<string>();
    }

    internal class Report
    {
        public readonly string Command;
        public string Project;
        public string Fatal;
        public string ApiDir;
        public string TiaVersion;
        public string Cpu;
        public string CompileState;
        public int CompileErrors;
        public int CompileWarnings;
        public readonly List<StepResult> Steps = new List<StepResult>();
        public readonly List<string> Warnings = new List<string>();
        public readonly List<string> Exported = new List<string>();
        public readonly List<Dictionary<string, object>> Messages = new List<Dictionary<string, object>>();

        public Report(string command)
        {
            Command = command;
        }

        public StepResult AddStep(string kind, string name, string file)
        {
            StepResult step = new StepResult();
            step.Kind = kind;
            step.Name = name;
            step.File = file;
            Steps.Add(step);
            return step;
        }

        public void Note(string text)
        {
            Warnings.Add(text);
            Console.WriteLine("  note: " + text);
        }

        public string ToJson()
        {
            Dictionary<string, object> root = new Dictionary<string, object>();
            root["bridgeFormat"] = 1;
            root["command"] = Command;
            root["createdAt"] = DateTime.UtcNow.ToString("o");
            root["project"] = Project;
            root["tiaVersion"] = TiaVersion;
            root["apiDir"] = ApiDir;
            root["cpu"] = Cpu;
            root["fatal"] = Fatal;
            Dictionary<string, object> compile = new Dictionary<string, object>();
            compile["state"] = CompileState;
            compile["errors"] = CompileErrors;
            compile["warnings"] = CompileWarnings;
            compile["messages"] = Messages;
            root["compile"] = compile;
            root["steps"] = Steps.Select(s =>
            {
                Dictionary<string, object> row = new Dictionary<string, object>();
                row["kind"] = s.Kind;
                row["name"] = s.Name;
                row["file"] = s.File;
                row["ok"] = s.Ok;
                row["error"] = s.Error;
                row["notes"] = s.Notes;
                return row;
            }).ToList();
            root["warnings"] = Warnings;
            root["exported"] = Exported;

            JavaScriptSerializer json = new JavaScriptSerializer();
            json.MaxJsonLength = int.MaxValue;
            return json.Serialize(root);
        }
    }
}
