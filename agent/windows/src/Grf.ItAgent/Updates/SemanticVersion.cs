namespace Grf.ItAgent.Updates;

internal sealed class SemanticVersion : IComparable<SemanticVersion>
{
    private const int MaximumLength = 100;
    private readonly string[] _core;
    private readonly string[] _preRelease;
    private readonly string _value;

    private SemanticVersion(string value, string[] core, string[] preRelease)
    {
        _value = value;
        _core = core;
        _preRelease = preRelease;
    }

    public static bool TryParse(string? value, out SemanticVersion? version)
    {
        version = null;
        if (string.IsNullOrEmpty(value) || value.Length > MaximumLength || !string.Equals(value, value.Trim(), StringComparison.Ordinal))
        {
            return false;
        }

        var buildSeparator = value.IndexOf('+');
        if (buildSeparator >= 0 && value.IndexOf('+', buildSeparator + 1) >= 0)
        {
            return false;
        }

        var precedencePart = buildSeparator >= 0 ? value[..buildSeparator] : value;
        var buildPart = buildSeparator >= 0 ? value[(buildSeparator + 1)..] : null;
        if (buildPart is not null && !ValidateIdentifiers(buildPart, allowLeadingZeroes: true))
        {
            return false;
        }

        var preReleaseSeparator = precedencePart.IndexOf('-');
        var corePart = preReleaseSeparator >= 0 ? precedencePart[..preReleaseSeparator] : precedencePart;
        var preReleasePart = preReleaseSeparator >= 0 ? precedencePart[(preReleaseSeparator + 1)..] : null;
        var core = corePart.Split('.');
        if (core.Length != 3 || core.Any(identifier => !IsNumericIdentifier(identifier, allowLeadingZeroes: false)))
        {
            return false;
        }

        if (preReleasePart is not null && !ValidateIdentifiers(preReleasePart, allowLeadingZeroes: false))
        {
            return false;
        }

        version = new SemanticVersion(value, core, preReleasePart?.Split('.') ?? []);
        return true;
    }

    public static SemanticVersion Parse(string value)
    {
        return TryParse(value, out var version)
            ? version!
            : throw new FormatException("La versión no cumple Semantic Versioning 2.0.");
    }

    public int CompareTo(SemanticVersion? other)
    {
        if (other is null)
        {
            return 1;
        }

        for (var index = 0; index < _core.Length; index++)
        {
            var comparison = CompareNumeric(_core[index], other._core[index]);
            if (comparison != 0)
            {
                return comparison;
            }
        }

        if (_preRelease.Length == 0 || other._preRelease.Length == 0)
        {
            return _preRelease.Length.CompareTo(other._preRelease.Length) * -1;
        }

        for (var index = 0; index < Math.Min(_preRelease.Length, other._preRelease.Length); index++)
        {
            var leftNumeric = IsAllDigits(_preRelease[index]);
            var rightNumeric = IsAllDigits(other._preRelease[index]);
            int comparison;
            if (leftNumeric && rightNumeric)
            {
                comparison = CompareNumeric(_preRelease[index], other._preRelease[index]);
            }
            else if (leftNumeric != rightNumeric)
            {
                comparison = leftNumeric ? -1 : 1;
            }
            else
            {
                comparison = string.Compare(_preRelease[index], other._preRelease[index], StringComparison.Ordinal);
            }

            if (comparison != 0)
            {
                return comparison;
            }
        }

        return _preRelease.Length.CompareTo(other._preRelease.Length);
    }

    public override string ToString() => _value;

    private static bool ValidateIdentifiers(string value, bool allowLeadingZeroes)
    {
        var identifiers = value.Split('.');
        return identifiers.Length > 0 && identifiers.All(identifier =>
            identifier.Length > 0
            && identifier.All(character => char.IsAsciiLetterOrDigit(character) || character == '-')
            && (allowLeadingZeroes || !IsAllDigits(identifier) || IsNumericIdentifier(identifier, allowLeadingZeroes: false)));
    }

    private static bool IsNumericIdentifier(string value, bool allowLeadingZeroes)
    {
        return value.Length > 0
            && IsAllDigits(value)
            && (allowLeadingZeroes || value.Length == 1 || value[0] != '0');
    }

    private static bool IsAllDigits(string value) => value.All(char.IsAsciiDigit);

    private static int CompareNumeric(string left, string right)
    {
        var lengthComparison = left.Length.CompareTo(right.Length);
        return lengthComparison != 0
            ? lengthComparison
            : string.Compare(left, right, StringComparison.Ordinal);
    }
}
