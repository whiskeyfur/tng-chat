-- The fixed lookups, for Science to show: the Morgan-Keenan spectral and luminosity classes (colour and
-- surface temperature, in kelvin), and planetary classes (the Federation's letters).
insert into spectral_classes (spectral_class, description, colour, temp_min_k, temp_max_k) values
  ('O', 'hottest, most massive; short-lived', 'blue', 30000, 60000),
  ('B', 'hot, luminous', 'blue-white', 10000, 30000),
  ('A', 'hot, strong hydrogen lines', 'white', 7500, 10000),
  ('F', 'warm', 'yellow-white', 6000, 7500),
  ('G', 'Sun-like', 'yellow', 5200, 6000),
  ('K', 'cooler, long-lived', 'orange', 3700, 5200),
  ('M', 'coolest true stars; most common', 'red', 2400, 3700),
  ('L', 'brown dwarf, hot', 'dark red', 1300, 2400),
  ('T', 'brown dwarf, methane', 'magenta-brown', 550, 1300),
  ('Y', 'brown dwarf, coolest', 'dark brown', 250, 550),
  ('DA', 'white dwarf: hydrogen lines', 'white', 6000, 100000),
  ('DB', 'white dwarf: helium lines', 'blue-white', 12000, 40000),
  ('DC', 'white dwarf: no strong lines', 'white to red', 4000, 11000),
  ('DO', 'white dwarf: ionized helium', 'blue-white', 45000, 150000),
  ('DQ', 'white dwarf: carbon features', 'white', 5000, 12000),
  ('DZ', 'white dwarf: metal lines', 'white', 5000, 12000)
on duplicate key update description = values(description), colour = values(colour), temp_min_k = values(temp_min_k), temp_max_k = values(temp_max_k);

insert into luminosity_classes (luminosity_class, description, sort_order) values
  ('0', 'hypergiant (Ia+)', 0), ('Ia', 'bright supergiant', 1), ('Iab', 'supergiant', 2), ('Ib', 'supergiant (less luminous)', 3),
  ('II', 'bright giant', 4), ('III', 'giant', 5), ('IV', 'subgiant', 6), ('V', 'main sequence (dwarf)', 7), ('VI', 'subdwarf', 8), ('VII', 'white dwarf', 9)
on duplicate key update description = values(description), sort_order = values(sort_order);

insert into planet_types (planet_type_code, planet_type_name, atmosphere, surface, habitability, description) values
  ('A', 'Geothermal', 'thin, volcanic gases', 'partly molten', 'none', 'Very young; still cooling.'),
  ('B', 'Geomorteus', 'thin, mostly helium and sodium', 'cratered, scorched', 'none', 'Small and close to its star, like Mercury.'),
  ('C', 'Geoinactive', 'none or trace', 'cold, geologically dead', 'none', 'An old world whose core has cooled.'),
  ('D', 'Planetoid', 'none', 'barren rock', 'none (domes only)', 'Asteroids and small moons.'),
  ('E', 'Geoplastic', 'hot, toxic', 'molten crust', 'none', 'A young world on its way to becoming habitable.'),
  ('F', 'Geometallic', 'thin, volcanic', 'metallic, active volcanism', 'microbial at most', 'Cooling after the molten stage.'),
  ('G', 'Geocrystalline', 'carbon dioxide and toxic gases', 'crystallizing crust', 'primitive single-celled life', 'Its crust still forming.'),
  ('H', 'Desert', 'thin to standard, dry', 'arid, hot', 'hardy life; marginal for humanoids', 'Little surface water.'),
  ('I', 'Gas supergiant', 'hydrogen and helium', 'none', 'none', 'Vast; the edge of being a brown dwarf.'),
  ('J', 'Gas giant', 'hydrogen and helium, deep and turbulent', 'none', 'none', 'Like Jupiter.'),
  ('K', 'Adaptable', 'thin, mostly carbon dioxide', 'barren, cold', 'habitable in domes or with terraforming', 'Like Mars.'),
  ('L', 'Marginal', 'oxygen-argon, thin', 'rocky, forested', 'plant life; colonizable', 'Habitable with some adaptation.'),
  ('M', 'Terrestrial', 'nitrogen-oxygen', 'land and oceans', 'habitable for humanoids', 'Earth-like.'),
  ('N', 'Reducing', 'dense carbon dioxide, sulfuric clouds', 'scorching', 'none', 'Like Venus.'),
  ('O', 'Pelagic', 'nitrogen-oxygen, humid', 'almost all ocean', 'habitable; marine life', 'An ocean world.'),
  ('P', 'Glaciated', 'thin, cold', 'ice', 'hardy life; habitable with shelter', 'Covered in ice.'),
  ('Q', 'Variable', 'varies with its orbit', 'varies', 'unpredictable', 'An eccentric orbit or a variable star swings its climate.'),
  ('R', 'Rogue', 'thin, held by internal heat', 'dark, volcanic', 'possible near vents', 'Drifting between stars.'),
  ('T', 'Gas ultragiant', 'hydrogen and helium', 'none', 'none', 'Larger still than a gas supergiant.'),
  ('Y', 'Demon', 'toxic, corrosive, extreme radiation', 'hostile', 'none', 'The most hostile class.')
on duplicate key update planet_type_name = values(planet_type_name), atmosphere = values(atmosphere), surface = values(surface), habitability = values(habitability), description = values(description);
