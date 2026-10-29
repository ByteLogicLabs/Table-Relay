package org.postgresql.util;

import java.util.Locale;

/**
 * pgjdbc's parser of the maxResultBuffer connection property, without java.lang.management, which Android doesn't
 * have (pgjdbc's own calls ManagementFactory on every connection). Percentages are of Runtime.maxMemory(); the
 * buffer is capped at 90% of it, as pgjdbc caps it at 90% of the heap. The jar's own copy is left out by the
 * engine's pgjdbcAndroid task.
 */
public class PGPropertyMaxResultBufferParser {
  private static final String[] PERCENT_SUFFIXES = {"percent", "pct", "p"};

  public static long parseProperty(String value) throws PSQLException {
    if (value == null || value.trim().isEmpty()) {
      return -1;
    }
    String v = value.trim().toLowerCase(Locale.ROOT);
    long max = Runtime.getRuntime().maxMemory();
    long result;
    try {
      String percent = null;
      for (String suffix : PERCENT_SUFFIXES) {
        if (v.endsWith(suffix)) {
          percent = v.substring(0, v.length() - suffix.length()).trim();
          break;
        }
      }
      if (percent != null) {
        result = (long) (Double.parseDouble(percent) / 100 * max);
      } else {
        long multiplier = 1;
        char unit = v.charAt(v.length() - 1);
        if (Character.isLetter(unit)) {
          switch (unit) {
            case 't': multiplier = 1L << 40; break;
            case 'g': multiplier = 1L << 30; break;
            case 'm': multiplier = 1L << 20; break;
            case 'k': multiplier = 1L << 10; break;
            default: throw new NumberFormatException(v);
          }
          v = v.substring(0, v.length() - 1).trim();
        }
        result = Long.parseLong(v) * multiplier;
      }
    } catch (NumberFormatException e) {
      throw new PSQLException("MaxResultBuffer parameter can't be parsed: " + value, PSQLState.SYNTAX_ERROR);
    }
    return Math.min(result, (long) (0.9 * max));
  }
}
